import type { NearbyResponse, OverviewResponse, SearchResponse } from "../shared/domain";

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
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("You appear to be offline.", 0);
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || body === null) throw new ApiError(body?.error ?? `Request failed (HTTP ${response.status}).`, response.status);
  return body;
}

export const fetchNearby = (lat: number, lng: number, radiusM: number, signal?: AbortSignal) =>
  getJson<NearbyResponse>(`/api/nearby?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}&radius=${radiusM}`, signal);

export const searchPlaces = (query: string, signal?: AbortSignal) =>
  getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}`, signal);

export const fetchOverview = (signal?: AbortSignal) => getJson<OverviewResponse>("/api/overview", signal);
