// Shared types for the Worker API and the app. Keep this file free of runtime dependencies.

/** One HDB carpark from the static registry (data.gov.sg "HDB Carpark Information"). */
export interface RegistryCarpark {
  id: string;
  address: string;
  /** Registry point converted from SVY21. Not necessarily the entrance. */
  lat: number;
  lng: number;
  carparkType: string;
  parkingSystem: string;
  /** Raw registry text, e.g. "WHOLE DAY", "7AM-10.30PM", "NO". */
  shortTermParking: string;
  /** Raw registry text, e.g. "SUN & PH FR 7AM-10.30PM", "NO". */
  freeParking: string;
  nightParking: boolean;
  /** Metres; null when the registry gives 0 or nothing. */
  gantryHeightM: number | null;
  basement: boolean;
}

export interface RegistryFile {
  source: { datasetId: string; name: string; publisher: string; fetchedAt: string };
  carparks: RegistryCarpark[];
}

/** Lot types used by the HDB availability feed. */
export type LotType = "C" | "H" | "Y" | "S" | (string & {});

/** Availability for one (carpark, lot type) pair, taken from a single upstream record. */
export interface LotAvailability {
  lotType: LotType;
  /** Null when the feed gives no usable number. Unknown is never zero. */
  available: number | null;
  total: number | null;
  /** Upstream record time (SGT, converted to ISO with offset). Not our fetch time. */
  recordedAt: string | null;
}

/** Normalised snapshot of the HDB availability feed, stored as the last good copy. */
export interface AvailabilitySnapshot {
  /** When ParkWhere received the upstream response. */
  fetchedAt: string;
  /** The feed's own top-level timestamp. */
  feedTimestamp: string | null;
  /** carpark id -> lot type -> availability */
  carparks: Record<string, Record<string, LotAvailability>>;
}

export type FeedState =
  /** Fresh fetch succeeded within the freshness window. */
  | "live"
  /** Serving the last good snapshot because the latest refresh failed. */
  | "last-good"
  /** No snapshot is available at all. */
  | "unavailable";

export interface FeedStatus {
  state: FeedState;
  fetchedAt: string | null;
  feedTimestamp: string | null;
  /** Set when the most recent refresh attempt failed. Sanitised, user-safe. */
  refreshError: string | null;
  lastAttemptAt: string | null;
}

export type RecordFreshness = "current" | "delayed" | "stale" | "unknown";

export interface CarAvailability {
  state: "known" | "unknown" | "not-in-feed";
  available: number | null;
  total: number | null;
  recordedAt: string | null;
  freshness: RecordFreshness;
}

export interface NearbyCarpark extends RegistryCarpark {
  distanceM: number;
  car: CarAvailability;
}

export interface NearbyResponse {
  query: { lat: number; lng: number; radiusM: number };
  feed: FeedStatus;
  registry: RegistryFile["source"] & { count: number };
  /** Short-term carparks inside the radius. Can exceed carparks.length (capped), or be below it (padded with nearest ones). */
  withinRadius: number;
  carparks: NearbyCarpark[];
}

export interface Place {
  name: string;
  address: string;
  postal: string | null;
  lat: number;
  lng: number;
}

export interface SearchResponse {
  query: string;
  results: Place[];
  source: string;
}
