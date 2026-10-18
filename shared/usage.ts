// Anonymous usage counts, written to Workers Analytics Engine to judge whether ParkWhere is useful.
// No cookies, no IDs, no IP addresses, no search text and no exact locations are ever written. A
// destination's rough area (a 0.02° cell, about 2 km) is written only for lookups that found no carpark
// nearby, never for Near me, so coverage gaps can be found. Each data point's index is its event name.
import type { CarparkSource, FeedState, NearbyCarpark } from "./domain";

/** Bumped when the positional blob or double layout changes, so old and new rows aren't mixed up. */
export const USAGE_SCHEMA = "v1";

/** How a lookup's destination was chosen. Only the first request for a destination carries one. */
export const LOOKUP_VIA = ["search", "pick", "near-me", "area", "link"] as const;
export type LookupVia = (typeof LOOKUP_VIA)[number];
export const isLookupVia = (value: unknown): value is LookupVia => (LOOKUP_VIA as readonly unknown[]).includes(value);
const AREA_VIA = new Set<LookupVia>(["search", "pick", "area"]);

export type Display = "standalone" | "browser";
const NAV_APPS = ["google", "apple", "waze"] as const;
const SOURCES: readonly CarparkSource[] = ["hdb", "lta", "ura", "osm"];

/** Whether a lookup answered "where can I park" with a count someone can act on. */
export type Answered =
  /** At least one HDB carpark inside the radius with a count from the last 15 minutes. */
  | "current-count"
  /** Carparks inside the radius have counts, but none current (old HDB, or LTA's undated counts). */
  | "older-count"
  /** Carparks inside the radius, none with a count (OpenStreetMap, or not in the feed). */
  | "no-count"
  /** Nothing inside the radius; the nearest carparks up to 2 km away were shown. */
  | "outside-radius"
  /** No carpark within 2 km. */
  | "none";

export interface DataPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

export function answeredBy(carparks: readonly NearbyCarpark[], radiusM: number): Answered {
  if (carparks.length === 0) return "none";
  const inside = carparks.filter((carpark) => carpark.distanceM <= radiusM);
  if (inside.length === 0) return "outside-radius";
  if (inside.some((carpark) => carpark.car.reportedBy === "HDB" && carpark.car.state === "known" && carpark.car.freshness === "current")) return "current-count";
  if (inside.some((carpark) => carpark.car.state === "known")) return "older-count";
  return "no-count";
}

/** The rough area of a destination, about 2 km across: "1.40,103.78". */
export const areaCell = (lat: number, lng: number) => `${(Math.floor(lat * 50) / 50).toFixed(2)},${(Math.floor(lng * 50) / 50).toFixed(2)}`;

export interface LookupFacts {
  via: LookupVia;
  radiusM: number;
  carparks: readonly NearbyCarpark[];
  withinRadius: number;
  origin: { lat: number; lng: number };
  hdbFeed: FeedState;
  ltaFeed: FeedState | null;
  display: Display;
  mobile: boolean;
  country: string;
  latencyMs: number;
}

/**
 * One destination lookup. Blobs: schema, via, answered, HDB feed, LTA feed, display, device, country,
 * gap area, radius. Doubles: carparks within radius, carparks shown, nearest metres (-1 if none), HDB,
 * LTA/URA and OpenStreetMap carparks shown, HDB carparks within radius with a current count, latency ms.
 */
export function lookupPoint(facts: LookupFacts): DataPoint {
  const answered = answeredBy(facts.carparks, facts.radiusM);
  // The area is recorded only where it's needed (no carpark in the radius), and only for places someone
  // searched for, picked or panned to. Never for Near me, which could show where someone lives or works,
  // nor for links, which include reloading a Near me result.
  const gap = (answered === "outside-radius" || answered === "none") && AREA_VIA.has(facts.via) ? areaCell(facts.origin.lat, facts.origin.lng) : "";
  const shown = (source: CarparkSource) => facts.carparks.filter((carpark) => (carpark.source ?? "hdb") === source).length;
  const current = facts.carparks.filter(
    (carpark) => carpark.distanceM <= facts.radiusM && carpark.car.reportedBy === "HDB" && carpark.car.state === "known" && carpark.car.freshness === "current"
  ).length;
  return {
    indexes: ["lookup"],
    blobs: [
      USAGE_SCHEMA,
      facts.via,
      answered,
      facts.hdbFeed,
      facts.ltaFeed ?? "off",
      facts.display,
      facts.mobile ? "mobile" : "desktop",
      facts.country,
      gap,
      String(facts.radiusM)
    ],
    doubles: [
      facts.withinRadius,
      facts.carparks.length,
      facts.carparks[0]?.distanceM ?? -1,
      shown("hdb"),
      shown("lta") + shown("ura"),
      shown("osm"),
      current,
      facts.latencyMs
    ]
  };
}

/** A page load: the first API request of a visit. Blobs: schema, display, device, country, referring site. */
export const visitPoint = (display: Display, mobile: boolean, country: string, referrer: string): DataPoint => ({
  indexes: ["visit"],
  blobs: [USAGE_SCHEMA, display, mobile ? "mobile" : "desktop", country, referrer],
  doubles: []
});

/** A place search request (debounced typing, so several per search). Never the query text. */
export function searchPoint(source: string, results: number, ok: boolean, latencyMs: number): DataPoint {
  const band = results === 0 ? "0" : results < 5 ? "1-4" : "5+";
  return { indexes: ["search"], blobs: [USAGE_SCHEMA, source, ok ? band : "error", ok ? "ok" : "error"], doubles: [results, latencyMs] };
}

/** An API request that failed on ParkWhere's side (HTTP 5xx). */
export const errorPoint = (route: string, status: number): DataPoint => ({ indexes: ["error"], blobs: [USAGE_SCHEMA, route], doubles: [status] });

/** Second-level labels under which the site name is the third label: "straitstimes.com.sg", "bbc.co.uk". */
const SECOND_LEVEL = new Set(["com", "edu", "gov", "org", "net", "co", "ac"]);

/**
 * Only another site's name is kept as a referrer, cut to its registrable part ("google.com",
 * "reddit.com", "straitstimes.com.sg"), so a personal subdomain or an IP address is never kept.
 */
export function referrerHost(value: string | null, ownHost: string): string {
  if (!value) return "";
  let host: string;
  try {
    host = (value.includes("/") ? new URL(value).hostname : value).toLowerCase();
  } catch {
    return "";
  }
  if (!/^[a-z0-9.-]{1,253}$/.test(host) || /^[0-9.]+$/.test(host) || !host.includes(".")) return "";
  const labels = host.split(".").filter(Boolean);
  const keep = labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  const site = labels.slice(-keep).join(".");
  const own = ownHost.toLowerCase().split(".").slice(-2).join(".");
  return site === own || site.length > 64 ? "" : site;
}

export interface DirectionsBeacon {
  event: "directions";
  app: (typeof NAV_APPS)[number];
  source: CarparkSource;
  /** True for the first directions opened for this destination, so lookups with a hand-off can be counted. */
  first: boolean;
  display: Display;
}

/** Checks a browser event against the allowlist. Anything else is dropped, never stored. */
export function parseBeacon(text: string): DirectionsBeacon | null {
  if (text.length > 1024) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { event, app, source, first, display } = body as Record<string, unknown>;
  if (event !== "directions") return null;
  if (!(NAV_APPS as readonly unknown[]).includes(app) || !(SOURCES as readonly unknown[]).includes(source)) return null;
  if (typeof first !== "boolean" || (display !== "standalone" && display !== "browser")) return null;
  return { event, app: app as DirectionsBeacon["app"], source: source as CarparkSource, first, display };
}

/** Blobs: schema, map app, carpark source, first for this destination, display. */
export const directionsPoint = (beacon: DirectionsBeacon, country: string): DataPoint => ({
  indexes: ["directions"],
  blobs: [USAGE_SCHEMA, beacon.app, beacon.source, beacon.first ? "first" : "again", beacon.display, country],
  doubles: []
});

const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|uptime|curl|wget|python|node-fetch|axios/i;

/**
 * True when a request must not be counted: the browser asks not to be tracked (Global Privacy Control or
 * Do Not Track), it's a ParkWhere check (CI and scripts send x-parkwhere-check), or it looks automated.
 */
export function usageBlocked(headers: Headers): boolean {
  return (
    headers.get("sec-gpc") === "1" ||
    headers.get("dnt") === "1" ||
    headers.has("x-parkwhere-check") ||
    BOT.test(headers.get("user-agent") ?? "")
  );
}

export const isMobile = (headers: Headers) => /Mobi|Android|iPhone|iPad/i.test(headers.get("user-agent") ?? "");
