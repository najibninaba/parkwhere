import { carAvailability, feedStatus } from "../shared/availability";
import type { CarAvailability, NearbyResponse, OsmFile, OverviewResponse, RegistryCarpark, RegistryFile } from "../shared/domain";
import { levelCode, overviewLevel } from "../shared/levels";
import { DEFAULT_RADIUS_M, RADIUS_OPTIONS_M, isInSingapore, nearbyCarparks } from "../shared/nearby";
import { LOADING_BAYS } from "../shared/tariff";
import { getFeed, getLtaFeed, type FeedEnv, type FeedRead, type LtaRead } from "./feed";
import { ltaAvailability, ltaRegistry } from "../shared/lta";
import { OSM_AVAILABILITY, osmRegistry, withoutDuplicates } from "../shared/osm";
import osmFile from "./osm-carparks.json";
import registryFile from "./registry.json";
import { SearchUnavailable, onemapConfigured, search, type SearchEnv } from "./search";
import {
  directionsPoint,
  errorPoint,
  isLookupVia,
  isMobile,
  lookupPoint,
  parseBeacon,
  referrerHost,
  searchPoint,
  usageBlocked,
  visitPoint,
  type DataPoint
} from "../shared/usage";

export interface Env extends FeedEnv, SearchEnv {
  ASSETS: Fetcher;
  SEARCH_LIMITER?: RateLimit;
  /** Anonymous usage counts (shared/usage.ts). Absent in PR previews and tests, where nothing is counted. */
  EVENTS?: AnalyticsEngineDataset;
  EVENT_LIMITER?: RateLimit;
}

/** Writes one usage data point. Counting never fails or slows a request. */
function count(env: Env, point: DataPoint) {
  try {
    env.EVENTS?.writeDataPoint(point);
  } catch (error) {
    console.warn("ParkWhere usage count failed", error instanceof Error ? error.message : error);
  }
}

const country = (request: Request) => (typeof request.cf?.country === "string" ? request.cf.country : "");

/** Per-visitor cap on counted requests, so a script can't flood the numbers. An abuse limit, not authentication. */
async function underEventLimit(request: Request, env: Env): Promise<boolean> {
  if (!env.EVENT_LIMITER) return true;
  const { success } = await env.EVENT_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
  return success;
}

/**
 * Whether this API request may be counted: the app adds c=1 only when counting is allowed in the browser
 * (no Global Privacy Control, Do Not Track, automation or ?nostats), the headers say the same, and the
 * visitor is under the event limit.
 */
async function countable(request: Request, url: URL, env: Env): Promise<boolean> {
  return Boolean(env.EVENTS) && url.searchParams.get("c") === "1" && !usageBlocked(request.headers) && (await underEventLimit(request, env));
}

/**
 * The first API request of a page load carries first=1, app=1 when ParkWhere runs as an installed app,
 * and the referring site's host name. That request counts as a visit.
 */
function countVisit(request: Request, url: URL, env: Env) {
  if (url.searchParams.get("first") !== "1") return;
  const display = url.searchParams.get("app") === "1" ? "standalone" : "browser";
  count(env, visitPoint(display, isMobile(request.headers), country(request), referrerHost(url.searchParams.get("ref"), url.hostname)));
}

const registry = registryFile as RegistryFile;
/** Visitor carparks only: loading/unloading bays are left out. */
const carparks = registry.carparks.filter((carpark) => !LOADING_BAYS.has(carpark.id));
/** Public carparks mapped on OpenStreetMap (no counts, no prices). scripts/sync-osm.ts already left out HDB duplicates. */
const osmCarparks = withoutDuplicates(osmRegistry(osmFile as OsmFile), carparks);

/** OpenStreetMap carparks minus any that duplicate an LTA or URA carpark, worked out once per LTA snapshot. */
let osmForLta: { fetchedAt: string | null; carparks: RegistryCarpark[] } | null = null;
function osmWithout(lta: RegistryCarpark[], fetchedAt: string | null): RegistryCarpark[] {
  if (osmForLta?.fetchedAt !== fetchedAt) osmForLta = { fetchedAt, carparks: withoutDuplicates(osmCarparks, lta) };
  return osmForLta.carparks;
}

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff" }
  });

const problem = (status: number, message: string) => json({ error: message }, status);

const storeDown = (label: string) => (error: unknown) => {
  console.error(`ParkWhere ${label} store failed`, error);
  return { snapshot: null, status: { lastAttemptAt: null, lastSuccessAt: null, lastError: "ParkWhere can't read its saved counts" } };
};

/**
 * Both feeds, read in parallel. A failing store or feed never takes the other down. The result lists
 * HDB carparks from the registry, LTA/URA carparks from LTA's last good snapshot and public carparks mapped
 * on OpenStreetMap, each with availability looked up in its own source (OpenStreetMap has none).
 */
async function readFeeds(env: Env, ctx: ExecutionContext, now: Date) {
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
  const [hdb, lta] = await Promise.all([
    getFeed(env, waitUntil).catch(storeDown("HDB")) as Promise<FeedRead>,
    getLtaFeed(env, waitUntil)?.catch(storeDown("LTA")) as Promise<LtaRead> | undefined
  ]);
  const ltaCarparks = lta ? ltaRegistry(lta.snapshot) : [];
  const all: RegistryCarpark[] = [...carparks, ...ltaCarparks, ...osmWithout(ltaCarparks, lta?.snapshot?.fetchedAt ?? null)];
  const availabilityOf = (carpark: RegistryCarpark): CarAvailability => {
    const source = carpark.source ?? "hdb";
    if (source === "hdb") return carAvailability(hdb.snapshot, carpark.id, now);
    if (source === "osm") return OSM_AVAILABILITY;
    return ltaAvailability(lta?.snapshot ?? null, carpark.id);
  };
  return {
    all,
    availabilityOf,
    hdbStatus: feedStatus(hdb.snapshot, hdb.status, now),
    ltaStatus: lta ? feedStatus(lta.snapshot, lta.status, now) : null
  };
}

async function nearby(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const radiusParam = Number(url.searchParams.get("radius") ?? DEFAULT_RADIUS_M);
  if (!url.searchParams.has("lat") || !url.searchParams.has("lng") || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return problem(400, "lat and lng are required");
  }
  if (!isInSingapore(lat, lng)) return problem(422, "That location is outside Singapore.");
  const radiusM = (RADIUS_OPTIONS_M as readonly number[]).includes(radiusParam) ? radiusParam : DEFAULT_RADIUS_M;

  const now = new Date();
  const feeds = await readFeeds(env, ctx, now);
  const result = nearbyCarparks(feeds.all, feeds.availabilityOf, { lat, lng }, radiusM);
  const body: NearbyResponse = {
    query: { lat, lng, radiusM },
    feed: feeds.hdbStatus,
    lta: feeds.ltaStatus,
    registry: { ...registry.source, count: carparks.length },
    withinRadius: result.withinRadius,
    carparks: result.carparks
  };
  // Only the first request for a destination says how it was chosen; refreshes and radius changes don't,
  // so they aren't counted as lookups.
  const via = url.searchParams.get("via");
  const counting = (url.searchParams.get("first") === "1" || isLookupVia(via)) && (await countable(request, url, env));
  if (counting) countVisit(request, url, env);
  if (counting && isLookupVia(via)) {
    count(env, lookupPoint({
      via,
      radiusM,
      carparks: result.carparks,
      withinRadius: result.withinRadius,
      origin: { lat, lng },
      hdbFeed: feeds.hdbStatus.state,
      ltaFeed: feeds.ltaStatus?.state ?? null,
      display: url.searchParams.get("app") === "1" ? "standalone" : "browser",
      mobile: isMobile(request.headers),
      country: country(request),
      latencyMs: Date.now() - started
    }));
  }
  return json(body);
}

/**
 * Every short-term carpark as a dot for the landing map. Only HDB counts recorded in the last 15
 * minutes are coloured or counted as "reporting"; LTA/URA counts have no time, so their dots are grey.
 */
async function overview(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (url.searchParams.get("first") === "1" && (await countable(request, url, env))) countVisit(request, url, env);
  const now = new Date();
  const feeds = await readFeeds(env, ctx, now);
  let reporting = 0;
  let withSpaces = 0;
  const points: OverviewResponse["points"] = [];
  for (const carpark of feeds.all) {
    if (carpark.shortTermParking === "NO") continue;
    const level = overviewLevel(feeds.availabilityOf(carpark), now.getTime());
    if (level !== "unknown") {
      reporting += 1;
      if (level !== "full") withSpaces += 1;
    }
    points.push([Number(carpark.lat.toFixed(5)), Number(carpark.lng.toFixed(5)), levelCode(level)]);
  }
  const body: OverviewResponse = { feed: feeds.hdbStatus, lta: feeds.ltaStatus, counts: { carparks: points.length, reporting, withSpaces }, points };
  return json(body, 200, "public, max-age=30");
}

async function searchRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  if (query.length < 2) return problem(400, "Type at least 2 characters.");
  if (env.SEARCH_LIMITER) {
    const { success } = await env.SEARCH_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
    if (!success) return problem(429, "Too many searches. Try again in a minute.");
  }
  const started = Date.now();
  const counted = await countable(request, url, env);
  if (counted) countVisit(request, url, env);
  try {
    const body = await search(env, carparks, query);
    if (counted) count(env, searchPoint(body.source, body.results.length, true, Date.now() - started));
    return json(body, 200, "private, max-age=300");
  } catch (error) {
    if (counted) count(env, searchPoint("failed", 0, false, Date.now() - started));
    console.warn("ParkWhere search failed", error instanceof Error ? error.message : error);
    return problem(502, error instanceof SearchUnavailable ? "Place search is unavailable right now." : "Place search failed.");
  }
}

/**
 * Usage events from the app (only "directions" today), sent with navigator.sendBeacon. Same-origin only,
 * rate-limited per visitor, at most 1 KB, and checked against an allowlist; anything else is dropped.
 * Always answers 204, so the page learns nothing either way.
 */
async function event(request: Request, url: URL, env: Env): Promise<Response> {
  const done = new Response(null, { status: 204 });
  // Browsers send these and pages can't forge them, so they keep other sites from counting through a
  // visitor's browser. A script can still send anything; the event limit caps what it can add.
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if ((site !== null && site !== "same-origin") || (origin !== null && origin !== url.origin) || (site === null && origin === null)) return done;
  if (!env.EVENTS || usageBlocked(request.headers) || !(await underEventLimit(request, env))) return done;
  const text = await readCapped(request, 1024);
  const beacon = text === null ? null : parseBeacon(text);
  if (beacon) count(env, directionsPoint(beacon, country(request)));
  return done;
}

/** The body as text, or null once it passes `limit` bytes, read as it arrives so a large body is never buffered. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function health(env: Env, ctx: ExecutionContext): Promise<Response> {
  const now = new Date();
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
  const [feed, lta] = await Promise.all([
    getFeed(env, waitUntil).catch(storeDown("HDB")) as Promise<FeedRead>,
    getLtaFeed(env, waitUntil)?.catch(storeDown("LTA")) as Promise<LtaRead> | undefined
  ]);
  const status = feedStatus(feed.snapshot, feed.status, now);
  return json(
    {
      // Health follows the HDB feed, which the app depends on; LTA is reported but optional.
      ok: status.state === "live",
      feed: status,
      lta: lta ? feedStatus(lta.snapshot, lta.status, now) : "not configured",
      registryFetchedAt: registry.source.fetchedAt,
      osmCarparks: osmCarparks.length,
      osmDataAt: (osmFile as OsmFile).source.dataAt,
      placeSearch: onemapConfigured(env) ? "onemap" : "hdb-registry"
    },
    status.state === "live" ? 200 : 503
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/event" && request.method === "POST") return await event(request, url, env).catch(() => new Response(null, { status: 204 }));
    if (request.method !== "GET" && request.method !== "HEAD") return problem(405, "Method not allowed");
    try {
      if (url.pathname === "/api/nearby") return await nearby(request, url, env, ctx);
      if (url.pathname === "/api/overview") return await overview(request, url, env, ctx);
      if (url.pathname === "/api/search") return await searchRoute(request, url, env);
      if (url.pathname === "/health") return await health(env, ctx);
      if (url.pathname.startsWith("/api/")) return problem(404, "Not found");
    } catch (error) {
      console.error("ParkWhere request failed", url.pathname, error);
      if (!usageBlocked(request.headers)) count(env, errorPoint(url.pathname, 500));
      return problem(500, "Something went wrong on our side.");
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
