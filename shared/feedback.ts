// In-app feedback (AGENTS.md rule 12): what a report may contain, and the checks the Worker applies
// before storing one. Pure logic, shared by the sheet, the Worker and `pnpm feedback`.
//
// A report holds the reason, the carpark and its source, what the card showed (count reports only),
// the note someone typed, the app version and the SGT date. Never an IP address, device, time of day,
// cookie, ID or location.
import type { CarAvailability, CarparkSource } from "./domain";
import { sgtParts } from "./sgt.ts";

export type FeedbackKind = "carpark" | "general";
export type CarparkReason = "location" | "closed" | "access" | "count" | "rates" | "not-carpark" | "other";
export type GeneralReason = "idea" | "problem" | "praise" | "missing";
export type FeedbackReason = CarparkReason | GeneralReason;

export const REASON_LABEL: Record<FeedbackReason, string> = {
  location: "The location or entrance is wrong",
  closed: "It's closed or gone",
  access: "Only residents, staff or season holders can park",
  count: "The count looks wrong",
  rates: "The rates look wrong",
  "not-carpark": "It isn't a carpark",
  other: "Something else",
  idea: "An idea",
  problem: "Something isn't working",
  praise: "Something you like",
  missing: "A carpark we've missed"
};

export const GENERAL_REASONS: readonly GeneralReason[] = ["idea", "problem", "praise", "missing"];

/**
 * The reasons a card offers. Rates only on HDB cards (no other source has published rates here), a
 * count only where there is one (HDB, LTA, URA), and "It isn't a carpark" only on OpenStreetMap cards.
 */
export function reasonsFor(source: CarparkSource): readonly CarparkReason[] {
  if (source === "hdb") return ["location", "closed", "access", "count", "rates", "other"];
  if (source === "osm") return ["location", "closed", "access", "not-carpark", "other"];
  return ["location", "closed", "access", "count", "other"];
}

/** Longest note, in characters: a carpark report is short, general feedback can say more. */
export const NOTE_LIMIT: Record<FeedbackKind, number> = { carpark: 500, general: 1000 };
/** The Worker reads at most this many bytes of a report. */
export const BODY_LIMIT_BYTES = 4096;
/** Reports stored per SGT day, at most. A safety valve against floods, not a quota anyone should reach. */
export const DAILY_CAP = 500;

/** What the client sends to POST /api/feedback. `website` is a hidden field people never fill in. */
export interface FeedbackBody {
  kind: FeedbackKind;
  reason: FeedbackReason;
  carparkId?: string | null;
  source?: CarparkSource | null;
  shown?: string | null;
  note?: string | null;
  appVersion?: string | null;
  website?: string;
}

/** A report that passed every check, ready to store. */
export interface FeedbackReport {
  kind: FeedbackKind;
  reason: FeedbackReason;
  carparkId: string | null;
  source: CarparkSource | null;
  shown: string | null;
  note: string | null;
  appVersion: string | null;
}

export type FeedbackCheck =
  | { kind: "ok"; report: FeedbackReport }
  /** The hidden field was filled in: dropped without a word. */
  | { kind: "bait" }
  | { kind: "invalid"; message: string };

const SOURCES: readonly CarparkSource[] = ["hdb", "lta", "ura", "osm"];
const KEYS = new Set(["kind", "reason", "carparkId", "source", "shown", "note", "appVersion", "website"]);
const CARPARK_ID = /^[A-Za-z0-9:/_.-]{1,80}$/;
/** What the card showed, as written by `shownText`: digits, words and a time. Nothing free-form. */
const SHOWN = /^[A-Za-z0-9 ,:.?-]{1,100}$/;
const APP_VERSION = /^[A-Za-z0-9.-]{1,40}$/;

const unreadable = { kind: "invalid", message: "ParkWhere couldn't read that report." } as const;

/**
 * Note text as stored: control characters other than line breaks and tabs removed, line breaks
 * made plain, and the ends trimmed. Empty means no note.
 */
export function cleanNote(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, "")
    .trim();
}

const optionalText = (value: unknown): string | null | undefined =>
  value === undefined || value === null ? null : typeof value === "string" ? value : undefined;

/** Checks a report body: the kind, reason, source and carpark must fit together, and the note must fit its limit. */
export function checkFeedback(text: string): FeedbackCheck {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return unreadable;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return unreadable;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !KEYS.has(key))) return unreadable;
  // The hidden field, checked first so a filled one is dropped whatever else it holds.
  if (record.website !== undefined && record.website !== "") return { kind: "bait" };

  const kind = record.kind;
  if (kind !== "carpark" && kind !== "general") return unreadable;
  const note = optionalText(record.note);
  const shown = optionalText(record.shown);
  const carparkId = optionalText(record.carparkId);
  const appVersion = optionalText(record.appVersion);
  if (note === undefined || shown === undefined || carparkId === undefined || appVersion === undefined) return unreadable;
  if (appVersion !== null && !APP_VERSION.test(appVersion)) return unreadable;
  const cleaned = note === null ? "" : cleanNote(note);
  if (cleaned.length > NOTE_LIMIT[kind]) return { kind: "invalid", message: `Keep the note under ${NOTE_LIMIT[kind].toLocaleString("en-SG")} characters.` };

  if (kind === "general") {
    if (!GENERAL_REASONS.includes(record.reason as GeneralReason)) return { kind: "invalid", message: "Choose what it's about." };
    if (carparkId !== null || (record.source ?? null) !== null || shown !== null) return unreadable;
    if (!cleaned) return { kind: "invalid", message: "Write a message." };
    return { kind: "ok", report: { kind, reason: record.reason as GeneralReason, carparkId: null, source: null, shown: null, note: cleaned, appVersion } };
  }

  const source = record.source;
  if (!SOURCES.includes(source as CarparkSource)) return unreadable;
  if (carparkId === null || !CARPARK_ID.test(carparkId)) return unreadable;
  const reason = record.reason as CarparkReason;
  if (!reasonsFor(source as CarparkSource).includes(reason)) {
    return { kind: "invalid", message: typeof record.reason === "string" && record.reason in REASON_LABEL ? "That reason doesn't apply to this carpark." : "Choose what's wrong." };
  }
  // Only a count report carries what the card showed.
  if (reason === "count" ? shown === null || !SHOWN.test(shown) : shown !== null) return unreadable;
  if (reason === "other" && !cleaned) return { kind: "invalid", message: "Add a note to say what's wrong." };
  return {
    kind: "ok",
    report: { kind, reason, carparkId, source: source as CarparkSource, shown, note: cleaned || null, appVersion }
  };
}

/** "2026-10-20": the date a report is stored under. Reports keep no time of day. */
export const receivedOn = (now: Date) => sgtParts(now).date;

/** The SGT date `days` before `date` ("YYYY-MM-DD"). */
export function daysBefore(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() - days);
  return instant.toISOString().slice(0, 10);
}

/** The same date a year earlier (29 Feb becomes 28 Feb). */
export function yearBefore(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const last = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return `${year - 1}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** Notes are kept until 180 days after a report is closed, and never more than 12 months after it arrived. */
export const KEEP_AFTER_CLOSING_DAYS = 180;

/**
 * Rows to delete on `today`: closed on or before the first date, or received on or before the second.
 */
export function purgeCutoffs(today: string): { closedOnOrBefore: string; receivedOnOrBefore: string } {
  return { closedOnOrBefore: daysBefore(today, KEEP_AFTER_CLOSING_DAYS), receivedOnOrBefore: yearBefore(today) };
}

const sgtClock = (iso: string) =>
  new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hourCycle: "h23", day: "numeric", month: "short" })
    .format(new Date(iso))
    .replace(/,/g, "");

/**
 * What a card's count box showed, in words that stay true later: "41 car lots available out of 143,
 * reported 20 Oct 10:02". LTA counts have no time or total, so they say so.
 */
export function shownText(car: CarAvailability): string {
  if (car.state === "not-in-feed") return "No live count";
  if (car.state === "unknown") return car.recordedAt ? `Count unknown, reported ${sgtClock(car.recordedAt)}` : "Count unknown";
  const lots = car.available ?? 0;
  if (car.reportedBy === "LTA") return `${lots} car lots available, as reported by LTA, no time or total`;
  const total = car.total === null ? "" : ` out of ${car.total}`;
  return `${lots} car lots available${total}, reported ${car.recordedAt ? sgtClock(car.recordedAt) : "at an unknown time"}`;
}

/** The note hash used for the same-day duplicate check: case and spacing don't make a report new. */
export async function noteHash(note: string | null): Promise<string> {
  const normal = (note ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normal));
  return [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Text from a stored report made safe to print in a terminal: escape sequences and other control
 * characters are removed, so a note can't move the cursor, recolour the screen or hide text.
 */
export function printable(value: string | null): string {
  if (value === null) return "";
  return value.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, "");
}
