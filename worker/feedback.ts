// In-app feedback (AGENTS.md rule 12): POST /api/feedback stores one report in D1, a daily Cron deletes
// old reports and a weekly Cron emails the owner a count of new ones. Note text is never logged, never
// emailed and never echoed back, and the Worker never posts anything publicly.
import type { CarparkSource } from "../shared/domain";
import {
  BODY_LIMIT_BYTES,
  DAILY_CAP,
  REASON_LABEL,
  checkFeedback,
  daysBefore,
  noteHash,
  purgeCutoffs,
  receivedOn,
  type FeedbackReason,
  type FeedbackReport
} from "../shared/feedback";
import { sgtParts } from "../shared/sgt";
import { readCapped, sameOrigin } from "./request";

export interface FeedbackEnv {
  DB: D1Database;
  /** 3 reports per 60 s per visitor. Keyed on the IP address, which is never stored. */
  FEEDBACK_LIMITER?: RateLimit;
  /** The weekly digest, to the one verified address fixed in the binding. Absent in previews and tests. */
  FEEDBACK_EMAIL?: SendEmail;
  /** "staging" on the staging Worker, so its digest says so. */
  PARKWHERE_ENV?: string;
}

/** Whether a carpark id belongs to a carpark ParkWhere lists from that source. */
export type CarparkExists = (source: CarparkSource, id: string) => Promise<boolean>;

/** Cron schedules, in UTC. They must match `triggers.crons` in wrangler.jsonc (a test checks). */
export const PURGE_CRON = "30 19 * * *"; // 03:30 SGT every day
export const DIGEST_CRON = "0 0 * * MON"; // 08:00 SGT on Mondays
/** Must match the send_email binding's destination_address in wrangler.jsonc (a test checks). */
export const DIGEST_TO = "najibninaba@gmail.com";
/** On bijan.app, where Email Routing is active, as Cloudflare requires of the sender. */
export const DIGEST_FROM = "parkwhere@bijan.app";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
  });
const problem = (status: number, message: string) => json({ error: message }, status);
const sent = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
export const feedbackUnavailable = () => problem(503, "Feedback isn't available right now.");

/** An error's message, cut short. Only D1 and binding errors reach here, never report text. */
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

type Stored = "stored" | "duplicate" | "full";

/**
 * Stores a report unless the day's cap is reached or the same report (carpark, reason and note) already
 * arrived today. The cap check sits inside the INSERT, so concurrent reports can't pass it together.
 */
async function store(db: D1Database, report: FeedbackReport, now: Date): Promise<Stored> {
  const day = receivedOn(now);
  const hash = await noteHash(report.note);
  const same = "received_on = ?1 AND kind = ?2 AND reason = ?3 AND carpark_id IS ?4 AND note_hash = ?5";
  const result = await db
    .prepare(
      `INSERT INTO feedback (received_on, kind, reason, carpark_id, note_hash, source, shown, note, app_version)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
       WHERE (SELECT COUNT(*) FROM feedback WHERE received_on = ?1) < ?10
         AND NOT EXISTS (SELECT 1 FROM feedback WHERE ${same})`
    )
    .bind(day, report.kind, report.reason, report.carparkId, hash, report.source, report.shown, report.note, report.appVersion, DAILY_CAP)
    .run();
  if ((result.meta.changes ?? 0) === 1) return "stored";
  const duplicate = await db
    .prepare(`SELECT 1 AS found FROM feedback WHERE ${same}`)
    .bind(day, report.kind, report.reason, report.carparkId, hash)
    .first();
  return duplicate ? "duplicate" : "full";
}

/**
 * POST /api/feedback. Answers 204 once a report is stored (or was already stored today), 400 or 429 with
 * a calm message, and 503 when the table or the limiter isn't there (PR previews before the migration).
 * Nothing from the report is echoed back.
 */
export async function feedbackRoute(request: Request, url: URL, env: FeedbackEnv, exists: CarparkExists, now = new Date()): Promise<Response> {
  if (!sameOrigin(request, url)) return problem(403, "Feedback can only be sent from ParkWhere.");
  if (!env.FEEDBACK_LIMITER) return feedbackUnavailable();
  const { success } = await env.FEEDBACK_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
  if (!success) return problem(429, "Too many reports in a short time. Wait a minute and try again.");
  const text = await readCapped(request, BODY_LIMIT_BYTES);
  if (text === null) return problem(400, "That report is too long.");
  const checked = checkFeedback(text);
  // A filled-in hidden field means a bot: it gets the same answer as a person, and nothing is kept.
  // Logged as a bare count, so a spike (or autofill catching real people) shows up in the logs.
  if (checked.kind === "bait") {
    console.log("ParkWhere feedback: dropped a report with the hidden field filled in");
    return sent();
  }
  if (checked.kind === "invalid") return problem(400, checked.message);
  const report = checked.report;
  try {
    if (report.source && report.carparkId && !(await exists(report.source, report.carparkId))) {
      return problem(400, "ParkWhere doesn't list that carpark.");
    }
    const outcome = await store(env.DB, report, now);
    if (outcome === "full") return problem(429, "ParkWhere has had a lot of reports today. Try again tomorrow.");
    return sent();
  } catch (error) {
    console.error("ParkWhere feedback store failed:", reason(error));
    return feedbackUnavailable();
  }
}

/** Deletes reports 180 days after they were closed, and 12 months after they arrived at the latest. */
export async function purgeFeedback(db: D1Database, now: Date): Promise<number> {
  const { closedOnOrBefore, receivedOnOrBefore } = purgeCutoffs(receivedOn(now));
  const result = await db
    .prepare("DELETE FROM feedback WHERE (closed_on IS NOT NULL AND closed_on <= ?1) OR received_on <= ?2")
    .bind(closedOnOrBefore, receivedOnOrBefore)
    .run();
  return result.meta.changes ?? 0;
}

const SOURCE_LABEL: Record<CarparkSource | "general", string> = {
  hdb: "HDB carparks",
  lta: "Mall carparks (LTA)",
  ura: "URA carparks (LTA)",
  osm: "OpenStreetMap carparks",
  general: "General feedback"
};

interface DigestRow {
  reason: FeedbackReason;
  source: CarparkSource | null;
  n: number;
  week: number;
}

/**
 * The weekly digest: counts only. It never carries note text, so nothing a person typed leaves D1 by
 * email. Null when there's nothing new to read.
 */
export function digestEmail(rows: DigestRow[], now: Date, staging: boolean): { subject: string; text: string } | null {
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  if (total === 0) return null;
  const week = rows.reduce((sum, row) => sum + row.week, 0);
  const tally = (key: (row: DigestRow) => string) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + row.n);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, n]) => `- ${label}: ${n}`);
  };
  const date = new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(now);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const text = [
    `ParkWhere feedback${staging ? " (staging)" : ""}, ${date}.`,
    "",
    `New reports waiting: ${total} (${plural(week, "report")} arrived in the last 7 days).`,
    "",
    "By reason",
    ...tally((row) => REASON_LABEL[row.reason]),
    "",
    "By source",
    ...tally((row) => SOURCE_LABEL[row.source ?? "general"]),
    "",
    `Notes aren't included in this email. Run \`pnpm feedback${staging ? " --staging" : ""}\` to read them.`
  ].join("\n");
  return { subject: `${staging ? "[staging] " : ""}ParkWhere feedback: ${plural(total, "new report")}`, text };
}

/** Sends the weekly digest. Does nothing without the email binding, or when no report is new. */
export async function sendDigest(env: FeedbackEnv, now: Date): Promise<"sent" | "nothing-new" | "no-binding"> {
  if (!env.FEEDBACK_EMAIL) return "no-binding";
  const weekStart = daysBefore(sgtParts(now).date, 6);
  const { results } = await env.DB
    .prepare("SELECT reason, source, COUNT(*) AS n, SUM(received_on >= ?1) AS week FROM feedback WHERE status = 'new' GROUP BY reason, source")
    .bind(weekStart)
    .all<DigestRow>();
  const email = digestEmail(results.map((row) => ({ ...row, n: Number(row.n), week: Number(row.week) })), now, env.PARKWHERE_ENV === "staging");
  if (!email) return "nothing-new";
  await env.FEEDBACK_EMAIL.send({ from: { name: "ParkWhere", email: DIGEST_FROM }, to: DIGEST_TO, subject: email.subject, text: email.text });
  return "sent";
}

/** The Cron entry point: the daily purge and the weekly digest. Failures are logged, never thrown at callers. */
export async function feedbackCron(cron: string, env: FeedbackEnv, now = new Date()): Promise<void> {
  try {
    if (cron === PURGE_CRON) {
      const deleted = await purgeFeedback(env.DB, now);
      console.log(`ParkWhere feedback purge deleted ${deleted} ${deleted === 1 ? "report" : "reports"}`);
    } else if (cron === DIGEST_CRON) {
      console.log(`ParkWhere feedback digest: ${await sendDigest(env, now)}`);
    }
  } catch (error) {
    console.error(`ParkWhere feedback cron "${cron}" failed:`, reason(error));
  }
}
