// Shared types for the Worker API and the app. Keep this file free of runtime dependencies.

/**
 * Who runs a carpark and where its data comes from. HDB carparks come from data.gov.sg; LTA and URA ones
 * from LTA DataMall; "osm" ones are mapped on OpenStreetMap (public carparks, and carparks at public places
 * with access unknown), with no count and no price.
 */
export type CarparkSource = "hdb" | "lta" | "ura" | "osm";

/**
 * One carpark. HDB carparks come from the static registry (data.gov.sg "HDB Carpark Information");
 * LTA and URA carparks are built from the LTA DataMall feed itself and fill HDB-only fields with "UNKNOWN".
 */
export interface RegistryCarpark {
  /** Absent means "hdb", so the bundled registry stays as published. */
  source?: CarparkSource;
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
  /** OpenStreetMap carparks only. */
  osm?: OsmDetails;
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
  /** HDB counts carry a record time and total; LTA DataMall counts have neither. Null: no source gives counts. */
  reportedBy: "HDB" | "LTA" | null;
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
  /** LTA DataMall feed for non-HDB carparks; null when LTA isn't configured. */
  lta: FeedStatus | null;
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

/** All carparks as map dots: [lat, lng, level code from shared/levels LEVEL_CODES]. */
export interface OverviewResponse {
  feed: FeedStatus;
  /** LTA DataMall feed behind the mall and URA dots; null when LTA isn't configured. */
  lta: FeedStatus | null;
  counts: { carparks: number; reporting: number; withSpaces: number };
  points: [number, number, number][];
}

/** A non-HDB carpark from LTA DataMall's CarParkAvailabilityv2 (Agency LTA or URA), car lots only. */
export interface LtaCarpark {
  /** "lta:1", "ura:A0007". */
  key: string;
  agency: "LTA" | "URA";
  carparkId: string;
  name: string;
  area: string | null;
  lat: number;
  lng: number;
  /** Car lots available as reported. LTA gives no total and no time. Null when unusable. */
  carLots: number | null;
}

export interface LtaSnapshot {
  /** When ParkWhere received the feed. LTA gives no record or feed time, so this is the only time we have. */
  fetchedAt: string;
  carparks: LtaCarpark[];
}

/** Access as tagged on OpenStreetMap. Only these explicit tags are kept; a missing tag never counts as public. */
export type OsmAccess = "yes" | "customers" | "permissive";

export interface OsmDetails {
  /** The mapped object, e.g. https://www.openstreetmap.org/way/177625322 */
  url: string;
  /** "unknown" only for a carpark mapped at a public place, which is never shown as public. */
  access: OsmAccess | "unknown";
  /** True when the point is a mapped carpark entrance; otherwise it's the middle of the mapped carpark. */
  atEntrance: boolean;
  /** False when OpenStreetMap gives no name, so the card shows what it is ("Underground carpark entrance"). */
  named: boolean;
  /** Set only for a carpark mapped at a public place: the place, and whether the carpark is inside its outline. */
  place?: { name: string; kind: OsmPlaceKind; relation: OsmPlaceRelation };
}

/** A public carpark or carpark entrance mapped on OpenStreetMap, as written by scripts/sync-osm.ts. */
export interface OsmCarpark {
  /** "way/177625322", "node/123", "relation/9". */
  id: string;
  kind: "carpark" | "entrance";
  name: string | null;
  operator: string | null;
  parking: "multi-storey" | "underground" | "surface" | "rooftop" | null;
  access: OsmAccess;
  /** From maxheight, in metres, when it's a plain number. */
  maxHeightM: number | null;
  lat: number;
  lng: number;
  atEntrance: boolean;
}

export type OsmPlaceKind = "mall" | "venue" | "attraction" | "terminal" | "park" | "sports";
/** "at": the carpark is mapped inside the place's outline. "next-to": outside it, within 30 m or named after the place. */
export type OsmPlaceRelation = "at" | "next-to";

/**
 * A carpark mapped at a public place (a mall, venue, attraction, terminal, park or sports ground) that has no
 * access tag, as written by scripts/sync-osm.ts. It says only that a carpark is mapped there: visitor access
 * is unknown and always shown as unconfirmed, never as public. One per place, and one mapped carpark never
 * makes more than one entry.
 */
export interface OsmPlaceCarpark {
  /** The place's OpenStreetMap object, e.g. "way/123". */
  id: string;
  kind: "place";
  placeName: string;
  placeKind: OsmPlaceKind;
  relation: OsmPlaceRelation;
  /**
   * The carpark's own mapped name, when the title needs it: the building it's under in a park ("SAFRA Choa
   * Chu Kang"), or to tell apart places with the same name ("Carpark 1", "Carpark 6" at Changi Beach Park).
   */
  carparkName?: string;
  /** OpenStreetMap ids of the parking features that show the carpark; the first is where the point is. */
  evidence: string[];
  /** True when the point is a mapped carpark entrance; otherwise it's a spot on a mapped carpark (where a road comes in, or well inside it). */
  atEntrance: boolean;
  parking: OsmCarpark["parking"];
  maxHeightM: number | null;
  access: "unknown";
  lat: number;
  lng: number;
}

export interface OsmFile {
  source: {
    name: "OpenStreetMap";
    licence: "ODbL-1.0";
    /** The Geofabrik extract it was cut from. */
    extract: string;
    /** When the extract's data was current (its replication timestamp). No build time, so an unchanged refresh leaves the file unchanged. */
    dataAt: string | null;
  };
  carparks: OsmCarpark[];
  /** Carparks mapped at public places, with access unknown. */
  places?: OsmPlaceCarpark[];
}
