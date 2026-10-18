import { describe, expect, it } from "vitest";
import registryFile from "../worker/registry.json";
import { carAvailability } from "./availability";
import type { AvailabilitySnapshot, RegistryCarpark, RegistryFile } from "./domain";
import { FALLBACK_LIMIT_M, MAX_RESULTS, distanceM, nearbyCarparks } from "./nearby";
import { svy21ToWgs84 } from "./svy21";

const registry = (registryFile as RegistryFile).carparks;
const now = new Date("2026-10-18T04:00:00Z");
const albertCentre = { lat: 1.30106, lng: 103.85412 };
const from = (snap: AvailabilitySnapshot | null) => (carpark: RegistryCarpark) => carAvailability(snap, carpark.id, now);

const snapshot: AvailabilitySnapshot = {
  fetchedAt: "2026-10-18T03:59:00Z",
  feedTimestamp: "2026-10-18T03:58:30Z",
  carparks: {
    ACB: {
      C: { lotType: "C", available: 50, total: 100, recordedAt: "2026-10-18T03:58:00Z" },
      Y: { lotType: "Y", available: 999, total: 999, recordedAt: "2026-10-18T03:58:00Z" }
    }
  }
};

describe("svy21ToWgs84", () => {
  it("converts the SVY21 origin and a known carpark", () => {
    expect(svy21ToWgs84(38744.572, 28001.642)).toEqual({ lat: expect.closeTo(1.366666, 6), lng: expect.closeTo(103.833333, 6) });
    // Albert Centre basement carpark (ACB): x 30314.7936, y 31490.4942
    const acb = svy21ToWgs84(31490.4942, 30314.7936);
    expect(distanceM(acb, albertCentre)).toBeLessThan(5);
  });
});

describe("nearbyCarparks", () => {
  it("returns the closest carpark first and matches availability by exact id", () => {
    const results = nearbyCarparks(registry, from(snapshot), albertCentre, 500).carparks;
    expect(results[0].id).toBe("ACB");
    expect(results[0].distanceM).toBeLessThan(10);
    expect(results[0].car).toMatchObject({ state: "known", available: 50, total: 100 });
    // Motorcycle lots are never counted as car spaces.
    expect(results[0].car.available).not.toBe(999);
  });

  it("sorts by distance, stays within the radius and lists each carpark once", () => {
    const results = nearbyCarparks(registry, from(snapshot), albertCentre, 500).carparks;
    expect(results.length).toBeGreaterThan(3);
    expect(results.length).toBeLessThanOrEqual(MAX_RESULTS);
    expect(results.every((carpark) => carpark.distanceM <= 500)).toBe(true);
    expect(results.map((carpark) => carpark.distanceM)).toEqual([...results.map((carpark) => carpark.distanceM)].sort((a, b) => a - b));
    expect(new Set(results.map((carpark) => carpark.id)).size).toBe(results.length);
  });

  it("marks carparks without feed data as not-in-feed rather than zero", () => {
    const results = nearbyCarparks(registry, from(snapshot), albertCentre, 500).carparks;
    const others = results.filter((carpark) => carpark.id !== "ACB");
    expect(others.every((carpark) => carpark.car.state === "not-in-feed" && carpark.car.available === null)).toBe(true);
    expect(nearbyCarparks(registry, from(null), albertCentre, 300).carparks[0].car.state).toBe("not-in-feed");
  });

  it("leaves out carparks with no short-term parking", () => {
    const seasonOnly = registry.find((carpark) => carpark.shortTermParking === "NO")!;
    const results = nearbyCarparks(registry, from(null), seasonOnly, 300).carparks;
    expect(results.some((carpark) => carpark.id === seasonOnly.id)).toBe(false);
  });

  it("falls back to the nearest few within 2 km when the radius is empty", () => {
    // Gardens by the Bay, far from HDB estates.
    const result = nearbyCarparks(registry, from(null), { lat: 1.28155, lng: 103.86396 }, 300);
    const results = result.carparks;
    expect(result.withinRadius).toBe(0);
    expect(results.length).toBeLessThanOrEqual(3);
    expect(results.every((carpark) => carpark.distanceM <= FALLBACK_LIMIT_M)).toBe(true);
  });

  it("reports how many carparks the cap left out", () => {
    // Bukit Merah has more HDB carparks within 1 km than the list shows.
    const result = nearbyCarparks(registry, from(null), { lat: 1.2819, lng: 103.8239 }, 1000);
    expect(result.carparks).toHaveLength(MAX_RESULTS);
    expect(result.withinRadius).toBeGreaterThan(MAX_RESULTS);
  });

  it("returns nothing when no HDB carpark is within 2 km", () => {
    expect(nearbyCarparks(registry, from(null), { lat: 1.2494, lng: 103.8303 }, 1000)).toEqual({ carparks: [], withinRadius: 0 }); // Sentosa
  });
});
