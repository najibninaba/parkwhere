// Last-good feed snapshots in D1, refreshed on demand. One store per source: HDB availability from
// data.gov.sg, and non-HDB carparks from LTA DataMall. Each source fails and recovers on its own.
//
// Policy, per source:
// - A snapshot younger than REFRESH_AFTER_MS is served as is.
// - An older one is still served, while one request refreshes it in the background.
// - With no snapshot, or one older than BLOCKING_AFTER_MS, the request waits (up to BLOCKING_WAIT_MS)
//   for a refresh and falls back to whatever snapshot exists if that refresh fails.
// - Only one refresh may start per CLAIM_MS across all isolates (claimed with a conditional
//   UPDATE), which keeps upstream calls at about one a minute however busy the app is.
import { Effect } from "effect";
import type { AvailabilitySnapshot, LtaSnapshot } from "../shared/domain";
import type { StoredStatus } from "../shared/availability";
import { fetchLta } from "./lta";
import { fetchAvailability, type Fetcher, type UpstreamError } from "./upstream";

export const REFRESH_AFTER_MS = 60_000;
export const BLOCKING_AFTER_MS = 5 * 60_000;
export const CLAIM_MS = 30_000;
/** Longest a request waits for a blocking refresh before answering with what it has. */
export const BLOCKING_WAIT_MS = 10_000;
const MEMORY_TTL_MS = 10_000;

export interface FeedEnv {
  DB: D1Database;
  DATA_GOV_SG_API_KEY?: string;
  LTA_DATAMALL_ACCOUNT_KEY?: string;
}

export interface Read<S> {
  snapshot: S | null;
  status: StoredStatus;
}
export type FeedRead = Read<AvailabilitySnapshot>;
export type LtaRead = Read<LtaSnapshot>;

/** A source's tables (fixed names, never user input), its fetch and its "slow" wording. */
interface Source<S extends { fetchedAt: string }> {
  name: "hdb" | "lta";
  snapshotTable: "feed_snapshot" | "lta_snapshot";
  statusTable: "feed_status" | "lta_status";
  slowMessage: string;
  fetch: (fetcher: Fetcher) => Effect.Effect<S, UpstreamError>;
}

const memory = new Map<string, { read: Read<unknown>; at: number }>();
export const resetFeedMemory = () => memory.clear();

const EMPTY_STATUS: StoredStatus = { lastAttemptAt: null, lastSuccessAt: null, lastError: null };

async function readStore<S extends { fetchedAt: string }>(db: D1Database, source: Source<S>): Promise<Read<S>> {
  const [snapshotRow, statusRow] = await db.batch<Record<string, string | null>>([
    db.prepare(`SELECT payload FROM ${source.snapshotTable} WHERE id = 1`),
    db.prepare(`SELECT last_attempt_at, last_success_at, last_error FROM ${source.statusTable} WHERE id = 1`)
  ]);
  const payload = snapshotRow.results[0]?.payload;
  const status = statusRow.results[0];
  let snapshot: S | null = null;
  if (payload) {
    try { snapshot = JSON.parse(payload) as S; } catch { snapshot = null; }
  }
  return {
    snapshot,
    status: status
      ? { lastAttemptAt: status.last_attempt_at ?? null, lastSuccessAt: status.last_success_at ?? null, lastError: status.last_error ?? null }
      : EMPTY_STATUS
  };
}

/** Atomically claims the right to refresh. Returns false if another request refreshed recently. */
async function claimRefresh<S extends { fetchedAt: string }>(db: D1Database, source: Source<S>, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - CLAIM_MS).toISOString();
  await db.prepare(`INSERT OR IGNORE INTO ${source.statusTable} (id, consecutive_failures) VALUES (1, 0)`).run();
  const result = await db
    .prepare(`UPDATE ${source.statusTable} SET last_attempt_at = ?1 WHERE id = 1 AND (last_attempt_at IS NULL OR last_attempt_at < ?2)`)
    .bind(now.toISOString(), cutoff)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

async function refresh<S extends { fetchedAt: string }>(db: D1Database, source: Source<S>, fetcher: Fetcher, now: Date): Promise<void> {
  const outcome = await Effect.runPromise(Effect.result(source.fetch(fetcher)));
  if (outcome._tag === "Success") {
    const snapshot = outcome.success;
    await db.batch([
      db.prepare(
        `INSERT INTO ${source.snapshotTable} (id, fetched_at, payload) VALUES (1, ?1, ?2) ` +
          "ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload"
      ).bind(snapshot.fetchedAt, JSON.stringify(snapshot)),
      db.prepare(`UPDATE ${source.statusTable} SET last_success_at = ?1, last_error = NULL, consecutive_failures = 0 WHERE id = 1`).bind(snapshot.fetchedAt)
    ]);
  } else {
    await db.prepare(`UPDATE ${source.statusTable} SET last_error = ?1, consecutive_failures = consecutive_failures + 1 WHERE id = 1`)
      .bind(outcome.failure.message)
      .run();
    console.warn(`ParkWhere ${source.name} refresh failed`, outcome.failure.message, now.toISOString());
  }
  memory.delete(source.name);
}

async function getSource<S extends { fetchedAt: string }>(
  db: D1Database,
  source: Source<S>,
  waitUntil: (promise: Promise<unknown>) => void,
  fetcher: Fetcher,
  now: Date,
  blockingWaitMs: number
): Promise<Read<S>> {
  const cached = memory.get(source.name);
  if (cached && now.getTime() - cached.at < MEMORY_TTL_MS) return cached.read as Read<S>;
  let read = await readStore(db, source);
  const age = read.snapshot ? now.getTime() - new Date(read.snapshot.fetchedAt).getTime() : Infinity;

  if (age > REFRESH_AFTER_MS) {
    try {
      if (await claimRefresh(db, source, now)) {
        if (age > BLOCKING_AFTER_MS) {
          // Wait a bounded time; a slow upstream finishes in the background and the next request gets it.
          const pending = refresh(db, source, fetcher, now);
          waitUntil(pending.catch((error) => console.error(`ParkWhere ${source.name} refresh crashed`, error)));
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finished = await Promise.race([
            pending.then(() => true),
            new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), blockingWaitMs); })
          ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
          read = await readStore(db, source);
          if (!finished) read = { ...read, status: { ...read.status, lastError: read.status.lastError ?? source.slowMessage } };
        } else {
          waitUntil(refresh(db, source, fetcher, now).catch((error) => console.error(`ParkWhere ${source.name} background refresh crashed`, error)));
        }
      }
    } catch (error) {
      // A storage failure while refreshing must not throw away the snapshot we already read.
      console.error(`ParkWhere ${source.name} refresh bookkeeping failed`, error);
      read = { snapshot: read.snapshot, status: { ...read.status, lastAttemptAt: now.toISOString(), lastError: "the latest check didn't finish" } };
    }
  }
  memory.set(source.name, { read, at: now.getTime() });
  return read;
}

/** HDB availability from data.gov.sg. */
export function getFeed(
  env: FeedEnv,
  waitUntil: (promise: Promise<unknown>) => void,
  fetcher: Fetcher = fetch,
  now = new Date(),
  blockingWaitMs = BLOCKING_WAIT_MS
): Promise<FeedRead> {
  return getSource<AvailabilitySnapshot>(env.DB, {
    name: "hdb",
    snapshotTable: "feed_snapshot",
    statusTable: "feed_status",
    slowMessage: "data.gov.sg is slow to respond.",
    fetch: (f) => fetchAvailability(f, env.DATA_GOV_SG_API_KEY)
  }, waitUntil, fetcher, now, blockingWaitMs);
}

/** Non-HDB carparks from LTA DataMall, or null when no LTA account key is configured. */
export function getLtaFeed(
  env: FeedEnv,
  waitUntil: (promise: Promise<unknown>) => void,
  fetcher: Fetcher = fetch,
  now = new Date(),
  blockingWaitMs = BLOCKING_WAIT_MS
): Promise<LtaRead> | null {
  const key = env.LTA_DATAMALL_ACCOUNT_KEY;
  if (!key) return null;
  return getSource<LtaSnapshot>(env.DB, {
    name: "lta",
    snapshotTable: "lta_snapshot",
    statusTable: "lta_status",
    slowMessage: "LTA DataMall is slow to respond.",
    fetch: (f) => fetchLta(f, key)
  }, waitUntil, fetcher, now, blockingWaitMs);
}
