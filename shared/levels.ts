import { recordFreshness } from "./availability";
import type { CarAvailability } from "./domain";

export type SpaceLevel = "plenty" | "some" | "few" | "full" | "unknown";

/** True when a count is recent enough to describe the carpark "now". */
export const isCurrent = (car: CarAvailability, now: number) => recordFreshness(car.recordedAt, new Date(now)) === "current";

/**
 * Colour level for a car count. Thresholds only drive colour; the number is always shown where there is room.
 * Unknown, missing and stale counts are all "unknown", never "full".
 */
export function spaceLevel(car: CarAvailability, now: number = Date.now()): SpaceLevel {
  if (car.state !== "known" || car.available === null) return "unknown";
  if (recordFreshness(car.recordedAt, new Date(now)) === "stale") return "unknown";
  if (car.available === 0) return "full";
  if (car.available < 10) return "few";
  if (car.available < 50) return "some";
  return "plenty";
}

/** Compact codes for the overview map payload. */
export const LEVEL_CODES: readonly SpaceLevel[] = ["unknown", "full", "few", "some", "plenty"];
export const levelCode = (level: SpaceLevel) => LEVEL_CODES.indexOf(level);
