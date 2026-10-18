import { describe, expect, it } from "vitest";
import type { CarAvailability, NearbyCarpark } from "./domain";
import { answeredBy, areaCell, lookupPoint, parseBeacon, referrerHost, searchPoint, usageBlocked } from "./usage";

const car = (overrides: Partial<CarAvailability>): CarAvailability => ({
  reportedBy: "HDB",
  state: "known",
  available: 40,
  total: 100,
  recordedAt: "2026-10-18T10:00:00Z",
  freshness: "current",
  ...overrides
});
const carpark = (id: string, distanceM: number, availability: CarAvailability, source?: NearbyCarpark["source"]): NearbyCarpark => ({
  source,
  id,
  address: id,
  lat: 1.3,
  lng: 103.85,
  carparkType: "",
  parkingSystem: "",
  shortTermParking: "WHOLE DAY",
  freeParking: "NO",
  nightParking: false,
  gantryHeightM: null,
  basement: false,
  distanceM,
  car: availability
});
const osm = { reportedBy: null, state: "not-in-feed", available: null, total: null, recordedAt: null, freshness: "unknown" } as const;

describe("answeredBy", () => {
  it("says whether a lookup found a current count inside the radius", () => {
    expect(answeredBy([carpark("A", 120, car({}))], 500)).toBe("current-count");
    expect(answeredBy([carpark("A", 120, car({ freshness: "stale" }))], 500)).toBe("older-count");
    expect(answeredBy([carpark("L", 120, car({ reportedBy: "LTA", freshness: "unknown", recordedAt: null }), "lta")], 500)).toBe("older-count");
    expect(answeredBy([carpark("O", 120, osm, "osm")], 500)).toBe("no-count");
    expect(answeredBy([carpark("A", 900, car({}))], 500)).toBe("outside-radius");
    expect(answeredBy([], 500)).toBe("none");
  });
});

describe("lookupPoint", () => {
  const base = {
    radiusM: 500,
    withinRadius: 0,
    origin: { lat: 1.40433, lng: 103.79304 },
    hdbFeed: "live" as const,
    ltaFeed: "live" as const,
    display: "browser" as const,
    mobile: true,
    country: "SG",
    latencyMs: 42
  };

  it("records the rough area only for gaps, and never for Near me", () => {
    const gap = lookupPoint({ ...base, via: "search", carparks: [carpark("O", 1435, osm, "osm")] });
    expect(gap.indexes).toEqual(["lookup"]);
    expect(gap.blobs).toEqual(["v1", "search", "outside-radius", "live", "live", "browser", "mobile", "SG", "1.40,103.78", "500"]);
    expect(gap.doubles).toEqual([0, 1, 1435, 0, 0, 1, 0, 42]);
    expect(lookupPoint({ ...base, via: "near-me", carparks: [] }).blobs[8]).toBe("");
    expect(lookupPoint({ ...base, via: "search", withinRadius: 1, carparks: [carpark("A", 100, car({}))] }).blobs[8]).toBe("");
  });

  it("never writes coordinates finer than the 2 km area", () => {
    const point = lookupPoint({ ...base, via: "pick", carparks: [] });
    expect(JSON.stringify(point)).not.toContain("1.404");
    expect(areaCell(1.30106, 103.85412)).toBe("1.30,103.84");
  });
});

describe("parseBeacon", () => {
  const good = { event: "directions", app: "google", source: "hdb", first: true, display: "browser" };

  it("accepts only the allowlisted directions event", () => {
    expect(parseBeacon(JSON.stringify(good))).toEqual(good);
    expect(parseBeacon(JSON.stringify({ ...good, app: "bing" }))).toBeNull();
    expect(parseBeacon(JSON.stringify({ ...good, event: "pageview" }))).toBeNull();
    expect(parseBeacon(JSON.stringify({ ...good, first: "yes" }))).toBeNull();
    expect(parseBeacon("not json")).toBeNull();
    expect(parseBeacon(JSON.stringify({ ...good, pad: "x".repeat(2000) }))).toBeNull();
  });
});

describe("usageBlocked and referrerHost", () => {
  it("skips Global Privacy Control, Do Not Track, ParkWhere's checks and bots", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
    expect(usageBlocked(new Headers({ "user-agent": ua }))).toBe(false);
    expect(usageBlocked(new Headers({ "user-agent": ua, "sec-gpc": "1" }))).toBe(true);
    expect(usageBlocked(new Headers({ "user-agent": ua, dnt: "1" }))).toBe(true);
    expect(usageBlocked(new Headers({ "user-agent": ua, "x-parkwhere-check": "1" }))).toBe(true);
    expect(usageBlocked(new Headers({ "user-agent": "curl/8.7.1" }))).toBe(true);
    expect(usageBlocked(new Headers({ "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }))).toBe(true);
  });

  it("keeps only another site's host name", () => {
    expect(referrerHost("https://www.google.com/search?q=parking", "parkwhere.bijan.app")).toBe("google.com");
    expect(referrerHost("https://parkwhere.bijan.app/?lat=1.3", "parkwhere.bijan.app")).toBe("");
    expect(referrerHost("javascript:alert(1)", "parkwhere.bijan.app")).toBe("");
    expect(referrerHost(null, "parkwhere.bijan.app")).toBe("");
  });

  it("bands search results and never sees the query", () => {
    expect(searchPoint("onemap", 7, true, 120).blobs).toEqual(["v1", "onemap", "5+", "ok"]);
    expect(searchPoint("failed", 0, false, 3000).blobs).toEqual(["v1", "failed", "error", "error"]);
  });
});
