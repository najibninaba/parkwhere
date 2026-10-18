// Destination search.
// - With ONEMAP_EMAIL and ONEMAP_PASSWORD set (a free OneMap API account), searches OneMap,
//   which the OneMap docs say requires a token. Tokens last three days and are kept in D1.
// - Without them, searches HDB carpark addresses in the registry only, and says so.
import { Schema } from "effect";
import type { Place, RegistryCarpark, SearchResponse } from "../shared/domain";
import { isInSingapore } from "../shared/nearby";
import type { Fetcher } from "./upstream";

const ONEMAP = "https://www.onemap.gov.sg";
const TOKEN_MARGIN_MS = 60 * 60_000;

export interface SearchEnv {
  DB: D1Database;
  ONEMAP_EMAIL?: string;
  ONEMAP_PASSWORD?: string;
}

export const onemapConfigured = (env: SearchEnv) => Boolean(env.ONEMAP_EMAIL && env.ONEMAP_PASSWORD);

const TokenResponse = Schema.Struct({ access_token: Schema.String, expiry_timestamp: Schema.Union([Schema.String, Schema.Number]) });
const SearchResult = Schema.Struct({
  SEARCHVAL: Schema.String,
  ADDRESS: Schema.String,
  POSTAL: Schema.optional(Schema.String),
  BUILDING: Schema.optional(Schema.String),
  LATITUDE: Schema.String,
  LONGITUDE: Schema.String
});
const OneMapSearch = Schema.Struct({ results: Schema.Array(SearchResult) });

export class SearchUnavailable extends Error {}

async function onemapToken(env: SearchEnv, fetcher: Fetcher, now: Date): Promise<string> {
  const row = await env.DB.prepare("SELECT token, expires_at FROM onemap_token WHERE id = 1").first<{ token: string; expires_at: string }>();
  if (row && new Date(row.expires_at).getTime() - TOKEN_MARGIN_MS > now.getTime()) return row.token;

  const response = await fetcher(`${ONEMAP}/api/auth/post/getToken`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: env.ONEMAP_EMAIL, password: env.ONEMAP_PASSWORD }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new SearchUnavailable(`OneMap sign-in returned HTTP ${response.status}`);
  const token = Schema.decodeUnknownSync(TokenResponse)(await response.json());
  const expiresAt = new Date(Number(token.expiry_timestamp) * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO onemap_token (id, token, expires_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at"
  ).bind(token.access_token, expiresAt).run();
  return token.access_token;
}

const title = (value: string) => value.toLowerCase().replace(/\b([a-z])/g, (letter) => letter.toUpperCase());

export async function searchOneMap(env: SearchEnv, query: string, fetcher: Fetcher = fetch, now = new Date()): Promise<Place[]> {
  const token = await onemapToken(env, fetcher, now);
  const url = `${ONEMAP}/api/common/elastic/search?searchVal=${encodeURIComponent(query)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const response = await fetcher(url, { headers: { Authorization: token, accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new SearchUnavailable(`OneMap search returned HTTP ${response.status}`);
  const decoded = Schema.decodeUnknownResult(OneMapSearch)(await response.json());
  if (decoded._tag === "Failure") throw new SearchUnavailable("OneMap search returned an unexpected format");
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const result of decoded.success.results) {
    const lat = Number(result.LATITUDE);
    const lng = Number(result.LONGITUDE);
    const key = `${result.SEARCHVAL}|${result.ADDRESS}`;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isInSingapore(lat, lng) || seen.has(key)) continue;
    seen.add(key);
    places.push({
      name: title(result.SEARCHVAL),
      address: title(result.ADDRESS),
      postal: result.POSTAL && result.POSTAL !== "NIL" ? result.POSTAL : null,
      lat,
      lng
    });
    if (places.length >= 8) break;
  }
  return places;
}

/** Keyless fallback: HDB carpark addresses whose words all start with the query's words. */
export function searchRegistry(registry: readonly RegistryCarpark[], query: string): Place[] {
  const words = query.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return registry
    .filter((carpark) => {
      const haystack = `${carpark.id} ${carpark.address}`.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/);
      return words.every((word) => haystack.some((token) => token.startsWith(word)));
    })
    .slice(0, 8)
    .map((carpark) => ({ name: title(carpark.address), address: `HDB carpark ${carpark.id}`, postal: null, lat: carpark.lat, lng: carpark.lng }));
}

export async function search(env: SearchEnv, registry: readonly RegistryCarpark[], query: string, fetcher: Fetcher = fetch): Promise<SearchResponse> {
  if (onemapConfigured(env)) {
    return { query, results: await searchOneMap(env, query, fetcher), source: "onemap" };
  }
  return { query, results: searchRegistry(registry, query), source: "hdb-registry" };
}
