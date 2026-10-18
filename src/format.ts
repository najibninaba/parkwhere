import { FEED_LIVE_MS, recordFreshness } from "../shared/availability";
import type { CarAvailability, FeedStatus } from "../shared/domain";

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function distance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

export function age(iso: string | null, now: number): string {
  if (!iso) return "time unknown";
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "time unknown";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function clock(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(iso));
}

export function stay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export type SpaceLevel = "plenty" | "some" | "few" | "full" | "unknown";

/** True when a count is recent enough to describe the carpark "now". Recomputed in the browser so it ages between refreshes. */
export const isCurrent = (car: CarAvailability, now: number) => recordFreshness(car.recordedAt, new Date(now)) === "current";

/** Visual level for a car count. Thresholds only drive colour; the number is always shown. Old counts are drawn as unknown. */
export function spaceLevel(car: CarAvailability, now: number = Date.now()): SpaceLevel {
  if (car.state !== "known" || car.available === null) return "unknown";
  if (recordFreshness(car.recordedAt, new Date(now)) === "stale") return "unknown";
  if (car.available === 0) return "full";
  if (car.available < 10) return "few";
  if (car.available < 50) return "some";
  return "plenty";
}

export function feedSentence(feed: FeedStatus, now: number): { tone: "ok" | "warn" | "bad"; text: string } {
  if (feed.state === "unavailable") {
    return { tone: "bad", text: `Live spaces are unavailable${feed.refreshError ? `: ${feed.refreshError}` : ""}. Carparks and prices are still shown.` };
  }
  if (feed.state === "last-good") {
    const why = feed.refreshError ? `Latest refresh failed (${feed.refreshError}). ` : "";
    return { tone: "warn", text: `${why}Showing the last good HDB data, fetched ${age(feed.fetchedAt, now)}.` };
  }
  if (!feed.fetchedAt || now - new Date(feed.fetchedAt).getTime() > FEED_LIVE_MS) {
    return { tone: "warn", text: `HDB data was fetched ${age(feed.fetchedAt, now)} and hasn't been refreshed since.` };
  }
  return { tone: "ok", text: `HDB data fetched ${age(feed.fetchedAt, now)}.` };
}

export const lotTypeNote = "Counts are car lots free in the whole carpark right now — not a reservation, and not a forecast for when you arrive.";
