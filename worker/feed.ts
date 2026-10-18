// Last-good availability snapshot in D1, refreshed on demand.
//
// Policy:
// - A snapshot younger than REFRESH_AFTER_MS is served as is.
// - An older one is still served, while one request refreshes it in the background.
// - With no snapshot, or one older than BLOCKING_AFTER_MS, the request waits for a refresh and
//   falls back to whatever snapshot exists if that refresh fails.
// - Only one refresh may start per CLAIM_MS across all isolates (claimed with a conditional
//   UPDATE), which keeps upstream calls at about one a minute however busy the app is.
import { Effect } from "effect";
import type { AvailabilitySnapshot } from "../shared/domain";
import type { StoredStatus } from "../shared/availability";
import { fetchAvailability, type Fetcher } from "./upstream";

export const REFRESH_AFTER_MS = 60_000;
export const BLOCKING_AFTER_MS = 5 * 60_000;
export const CLAIM_MS = 30_000;
/** Longest a request waits for a blocking refresh before answering with what it has. */
export const BLOCKING_WAIT_MS = 10_000;
const MEMORY_TTL_MS = 10_000;

export interface FeedEnv {
  DB: D1Database;
  DATA_GOV_SG_API_KEY?: string;
}

export interface FeedRead {
  snapshot: AvailabilitySnapshot | null;
  status: StoredStatus;
}

let memory: { read: FeedRead; at: number } | null = null;
export const resetFeedMemory = () => { memory = null; };

const EMPTY_STATUS: StoredStatus = { lastAttemptAt: null, lastSuccessAt: null, lastError: null };

async function readStore(db: D1Database): Promise<FeedRead> {
  const [snapshotRow, statusRow] = await db.batch<Record<string, string | null>>([
    db.prepare("SELECT payload FROM feed_snapshot WHERE id = 1"),
    db.prepare("SELECT last_attempt_at, last_success_at, last_error FROM feed_status WHERE id = 1")
  ]);
  const payload = snapshotRow.results[0]?.payload;
  const status = statusRow.results[0];
  let snapshot: AvailabilitySnapshot | null = null;
  if (payload) {
    try { snapshot = JSON.parse(payload) as AvailabilitySnapshot; } catch { snapshot = null; }
  }
  return {
    snapshot,
    status: status
      ? { lastAttemptAt: status.last_attempt_at ?? null, lastSuccessAt: status.last_success_at ?? null, lastError: status.last_error ?? null }
      : EMPTY_STATUS
  };
}

/** Atomically claims the right to refresh. Returns false if another request refreshed recently. */
async function claimRefresh(db: D1Database, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - CLAIM_MS).toISOString();
  const attempt = now.toISOString();
  await db.prepare("INSERT OR IGNORE INTO feed_status (id, consecutive_failures) VALUES (1, 0)").run();
  const result = await db
    .prepare("UPDATE feed_status SET last_attempt_at = ?1 WHERE id = 1 AND (last_attempt_at IS NULL OR last_attempt_at < ?2)")
    .bind(attempt, cutoff)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

async function refresh(env: FeedEnv, fetcher: Fetcher, now: Date): Promise<void> {
  const outcome = await Effect.runPromise(Effect.result(fetchAvailability(fetcher, env.DATA_GOV_SG_API_KEY, () => new Date())));
  if (outcome._tag === "Success") {
    const snapshot = outcome.success;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO feed_snapshot (id, fetched_at, feed_timestamp, payload) VALUES (1, ?1, ?2, ?3) " +
          "ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, feed_timestamp = excluded.feed_timestamp, payload = excluded.payload"
      ).bind(snapshot.fetchedAt, snapshot.feedTimestamp, JSON.stringify(snapshot)),
      env.DB.prepare("UPDATE feed_status SET last_success_at = ?1, last_error = NULL, consecutive_failures = 0 WHERE id = 1").bind(snapshot.fetchedAt)
    ]);
  } else {
    await env.DB.prepare("UPDATE feed_status SET last_error = ?1, consecutive_failures = consecutive_failures + 1 WHERE id = 1")
      .bind(outcome.failure.message)
      .run();
    console.warn("ParkWhere availability refresh failed", outcome.failure.message, now.toISOString());
  }
  memory = null;
}

export async function getFeed(
  env: FeedEnv,
  waitUntil: (promise: Promise<unknown>) => void,
  fetcher: Fetcher = fetch,
  now = new Date(),
  blockingWaitMs = BLOCKING_WAIT_MS
): Promise<FeedRead> {
  if (memory && now.getTime() - memory.at < MEMORY_TTL_MS) return memory.read;
  let read = await readStore(env.DB);
  const age = read.snapshot ? now.getTime() - new Date(read.snapshot.fetchedAt).getTime() : Infinity;

  if (age > REFRESH_AFTER_MS) {
    try {
      if (await claimRefresh(env.DB, now)) {
        if (age > BLOCKING_AFTER_MS) {
          // Wait a bounded time; a slow upstream finishes in the background and the next request gets it.
          const pending = refresh(env, fetcher, now);
          waitUntil(pending.catch((error) => console.error("ParkWhere refresh crashed", error)));
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finished = await Promise.race([
            pending.then(() => true),
            new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), blockingWaitMs); })
          ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
          read = await readStore(env.DB);
          if (!finished) read = { ...read, status: { ...read.status, lastError: read.status.lastError ?? "data.gov.sg is slow to respond." } };
        } else {
          waitUntil(refresh(env, fetcher, now).catch((error) => console.error("ParkWhere background refresh crashed", error)));
        }
      }
    } catch (error) {
      // A storage failure while refreshing must not throw away the snapshot we already read.
      console.error("ParkWhere refresh bookkeeping failed", error);
      read = { snapshot: read.snapshot, status: { ...read.status, lastAttemptAt: now.toISOString(), lastError: "Couldn't refresh availability." } };
    }
  }
  memory = { read, at: now.getTime() };
  return read;
}
