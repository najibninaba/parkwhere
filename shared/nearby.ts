import { carAvailability } from "./availability";
import type { AvailabilitySnapshot, NearbyCarpark, RegistryCarpark } from "./domain";

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in metres. This is straight-line distance, not walking or driving distance. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rough bounding box for mainland Singapore and the nearer islands. */
export const SINGAPORE_BOUNDS = { minLat: 1.15, maxLat: 1.48, minLng: 103.59, maxLng: 104.1 };

export const isInSingapore = (lat: number, lng: number) =>
  lat >= SINGAPORE_BOUNDS.minLat && lat <= SINGAPORE_BOUNDS.maxLat && lng >= SINGAPORE_BOUNDS.minLng && lng <= SINGAPORE_BOUNDS.maxLng;

export const RADIUS_OPTIONS_M = [300, 500, 1000] as const;
export const DEFAULT_RADIUS_M = 500;
export const MAX_RESULTS = 25;
/** When the radius holds fewer than this many carparks, the nearest ones within FALLBACK_LIMIT_M are added. */
export const MIN_RESULTS = 3;
export const FALLBACK_LIMIT_M = 2000;

export interface NearbyResult {
  carparks: NearbyCarpark[];
  /** How many short-term carparks are inside the radius, before the MAX_RESULTS cap. */
  withinRadius: number;
}

/**
 * Carparks near a point, nearest first. Each registry carpark appears once; availability
 * is looked up by its exact registry id. Carparks with no short-term parking are left out.
 */
export function nearbyCarparks(
  registry: readonly RegistryCarpark[],
  snapshot: AvailabilitySnapshot | null,
  origin: { lat: number; lng: number },
  radiusM: number,
  now: Date
): NearbyResult {
  const ranked = registry
    .filter((carpark) => carpark.shortTermParking !== "NO")
    .map((carpark) => ({ carpark, distanceM: distanceM(origin, carpark) }))
    .sort((left, right) => left.distanceM - right.distanceM || left.carpark.id.localeCompare(right.carpark.id));

  const inside = ranked.filter((entry) => entry.distanceM <= radiusM);
  const chosen = inside.length < MIN_RESULTS ? ranked.filter((entry) => entry.distanceM <= FALLBACK_LIMIT_M).slice(0, MIN_RESULTS) : inside;

  return {
    withinRadius: inside.length,
    carparks: chosen.slice(0, MAX_RESULTS).map(({ carpark, distanceM: distance }) => ({
      ...carpark,
      distanceM: Math.round(distance),
      car: carAvailability(snapshot, carpark.id, now)
    }))
  };
}
