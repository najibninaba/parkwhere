import { carAvailability, feedStatus } from "../shared/availability";
import type { NearbyResponse, OverviewResponse, RegistryFile } from "../shared/domain";
import { levelCode, overviewLevel } from "../shared/levels";
import { DEFAULT_RADIUS_M, RADIUS_OPTIONS_M, isInSingapore, nearbyCarparks } from "../shared/nearby";
import { LOADING_BAYS } from "../shared/tariff";
import { getFeed, type FeedEnv, type FeedRead } from "./feed";
import registryFile from "./registry.json";
import { SearchUnavailable, onemapConfigured, search, type SearchEnv } from "./search";

export interface Env extends FeedEnv, SearchEnv {
  ASSETS: Fetcher;
  SEARCH_LIMITER?: RateLimit;
}

const registry = registryFile as RegistryFile;
/** Visitor carparks only: loading/unloading bays are left out. */
const carparks = registry.carparks.filter((carpark) => !LOADING_BAYS.has(carpark.id));

const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff" }
  });

const problem = (status: number, message: string) => json({ error: message }, status);

async function nearby(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const radiusParam = Number(url.searchParams.get("radius") ?? DEFAULT_RADIUS_M);
  if (!url.searchParams.has("lat") || !url.searchParams.has("lng") || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return problem(400, "lat and lng are required");
  }
  if (!isInSingapore(lat, lng)) return problem(422, "That location is outside Singapore.");
  const radiusM = (RADIUS_OPTIONS_M as readonly number[]).includes(radiusParam) ? radiusParam : DEFAULT_RADIUS_M;

  const now = new Date();
  const feed = await getFeed(env, (promise) => ctx.waitUntil(promise)).catch((error: unknown): FeedRead => {
    console.error("ParkWhere availability store failed", error);
    return { snapshot: null, status: { lastAttemptAt: null, lastSuccessAt: null, lastError: "Availability is temporarily unavailable." } };
  });
  const result = nearbyCarparks(carparks, feed.snapshot, { lat, lng }, radiusM, now);
  const body: NearbyResponse = {
    query: { lat, lng, radiusM },
    feed: feedStatus(feed.snapshot, feed.status, now),
    registry: { ...registry.source, count: carparks.length },
    withinRadius: result.withinRadius,
    carparks: result.carparks
  };
  return json(body);
}

/** Every short-term HDB carpark as a coloured dot, for the landing map. */
async function overview(env: Env, ctx: ExecutionContext): Promise<Response> {
  const now = new Date();
  const feed = await getFeed(env, (promise) => ctx.waitUntil(promise)).catch((error: unknown): FeedRead => {
    console.error("ParkWhere availability store failed", error);
    return { snapshot: null, status: { lastAttemptAt: null, lastSuccessAt: null, lastError: "Availability is temporarily unavailable." } };
  });
  let reporting = 0;
  let withSpaces = 0;
  const points: OverviewResponse["points"] = [];
  for (const carpark of carparks) {
    if (carpark.shortTermParking === "NO") continue;
    const car = carAvailability(feed.snapshot, carpark.id, now);
    const level = overviewLevel(car, now.getTime());
    // Same rule as the dot colours: only counts recorded in the last 15 minutes are "reporting" now.
    if (level !== "unknown") {
      reporting += 1;
      if (level !== "full") withSpaces += 1;
    }
    points.push([Number(carpark.lat.toFixed(5)), Number(carpark.lng.toFixed(5)), levelCode(level)]);
  }
  const body: OverviewResponse = { feed: feedStatus(feed.snapshot, feed.status, now), counts: { carparks: points.length, reporting, withSpaces }, points };
  return json(body, 200, "public, max-age=30");
}

async function searchRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  if (query.length < 2) return problem(400, "Type at least 2 characters.");
  if (env.SEARCH_LIMITER) {
    const { success } = await env.SEARCH_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
    if (!success) return problem(429, "Too many searches. Try again in a minute.");
  }
  try {
    return json(await search(env, carparks, query), 200, "private, max-age=300");
  } catch (error) {
    console.warn("ParkWhere search failed", error instanceof Error ? error.message : error);
    return problem(502, error instanceof SearchUnavailable ? "Place search is unavailable right now." : "Place search failed.");
  }
}

async function health(env: Env, ctx: ExecutionContext): Promise<Response> {
  const now = new Date();
  const feed = await getFeed(env, (promise) => ctx.waitUntil(promise));
  const status = feedStatus(feed.snapshot, feed.status, now);
  return json(
    {
      ok: status.state === "live",
      feed: status,
      registryFetchedAt: registry.source.fetchedAt,
      placeSearch: onemapConfigured(env) ? "onemap" : "hdb-registry"
    },
    status.state === "live" ? 200 : 503
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return problem(405, "Method not allowed");
    try {
      if (url.pathname === "/api/nearby") return await nearby(url, env, ctx);
      if (url.pathname === "/api/overview") return await overview(env, ctx);
      if (url.pathname === "/api/search") return await searchRoute(request, url, env);
      if (url.pathname === "/health") return await health(env, ctx);
      if (url.pathname.startsWith("/api/")) return problem(404, "Not found");
    } catch (error) {
      console.error("ParkWhere request failed", url.pathname, error);
      return problem(500, "Something went wrong on our side.");
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
