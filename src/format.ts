import { FEED_LIVE_MS } from "../shared/availability";
import type { FeedStatus } from "../shared/domain";
export { isCurrent, spaceLevel, type SpaceLevel } from "../shared/levels";

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

/** The LTA DataMall line, shown when LTA or URA carparks are in the results. */
export function ltaSentence(lta: FeedStatus, now: number): { tone: "ok" | "warn" | "bad"; text: string } {
  if (lta.state === "unavailable") return { tone: "bad", text: `Mall and URA counts are unavailable${lta.refreshError ? `: ${lta.refreshError}` : ""}.` };
  const fetched = `Mall and URA counts from LTA DataMall, fetched ${age(lta.fetchedAt, now)}. LTA doesn't say when each carpark last reported.`;
  if (lta.state === "last-good") return { tone: "warn", text: `${lta.refreshError ? `Latest LTA refresh failed (${lta.refreshError}). ` : ""}${fetched}` };
  return { tone: "ok", text: fetched };
}

export const lotTypeNote = "Counts are car lots free in the whole carpark right now — not a reservation, and not a forecast for when you arrive.";
