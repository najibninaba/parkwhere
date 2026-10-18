import type { NearbyResponse, OverviewResponse, SearchResponse } from "../shared/domain";
import type { LookupVia } from "../shared/usage";
import { usageParams, visitNotDelivered } from "./usage";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, headers: { accept: "application/json" } });
  } catch (error) {
    if (path.includes("first=1")) visitNotDelivered();
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("You appear to be offline.", 0);
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || body === null) {
    if (path.includes("first=1")) visitNotDelivered();
    throw new ApiError(body?.error ?? `Request failed (HTTP ${response.status}).`, response.status);
  }
  return body;
}

/** `via` is set only on the first request for a destination, which is what counts as a lookup. */
export const fetchNearby = (lat: number, lng: number, radiusM: number, signal?: AbortSignal, via?: LookupVia) =>
  getJson<NearbyResponse>(`/api/nearby?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}&radius=${radiusM}${usageParams(via)}`, signal);

export const searchPlaces = (query: string, signal?: AbortSignal) =>
  getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}${usageParams()}`, signal);

export const fetchOverview = (signal?: AbortSignal) => {
  const usage = usageParams();
  return getJson<OverviewResponse>(usage ? `/api/overview?${usage.slice(1)}` : "/api/overview", signal);
};
