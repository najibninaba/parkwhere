import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import sample from "../fixtures/hdb-availability.sample.json";
import { AvailabilityResponse } from "./feed-schema";
import { carAvailability, feedStatus, normaliseAvailability, recordFreshness, sgtToIso } from "./availability";

const decoded = Schema.decodeUnknownSync(AvailabilityResponse)(sample);
// The fixture's feed timestamp is 2026-10-18T11:51:36+08:00.
const fetchedAt = new Date("2026-10-18T03:52:13Z");
const snapshot = normaliseAvailability(decoded, fetchedAt);

describe("normaliseAvailability (real feed sample)", () => {
  it("keeps the feed timestamp separate from our fetch time", () => {
    expect(snapshot.fetchedAt).toBe("2026-10-18T03:52:13.000Z");
    expect(snapshot.feedTimestamp).toBe("2026-10-18T03:51:36.000Z");
  });

  it("reads record times as Singapore time", () => {
    expect(sgtToIso("2026-10-18T11:50:42")).toBe("2026-10-18T03:50:42.000Z");
    expect(sgtToIso("not a time")).toBeNull();
    expect(sgtToIso(null)).toBeNull();
  });

  it("merges split records by lot type without adding them together", () => {
    // TBM2 arrives as two records: cars + heavy vehicles, then motorcycles.
    expect(snapshot.carparks.TBM2.C).toEqual({ lotType: "C", available: 232, total: 243, recordedAt: "2026-10-18T03:44:03.000Z" });
    expect(snapshot.carparks.TBM2.Y.available).toBe(71);
    expect(snapshot.carparks.TBM2.H.available).toBe(1);
    expect(Object.keys(snapshot.carparks.TBM2).sort()).toEqual(["C", "H", "Y"]);
  });

  it("keeps each lot type's own record time when a carpark has old and new records", () => {
    expect(snapshot.carparks.JM33.C.recordedAt).toBe("2026-10-18T03:50:38.000Z");
    expect(snapshot.carparks.JM33.S.recordedAt).toBe("2026-05-07T06:39:09.000Z");
  });

  it("treats a zero total as unknown, not as zero spaces", () => {
    expect(snapshot.carparks.PL40.C).toMatchObject({ available: null, total: null });
  });

  it("keeps the newest record if the same carpark and lot type appear twice", () => {
    const twice = Schema.decodeUnknownSync(AvailabilityResponse)({
      items: [{ timestamp: null, carpark_data: [
        { carpark_number: "Z1", update_datetime: "2026-10-18T11:40:00", carpark_info: [{ lot_type: "C", lots_available: "5", total_lots: "10" }] },
        { carpark_number: "Z1", update_datetime: "2026-10-18T11:45:00", carpark_info: [{ lot_type: "C", lots_available: "7", total_lots: "10" }] },
        { carpark_number: "Z1", update_datetime: "2026-10-18T11:30:00", carpark_info: [{ lot_type: "C", lots_available: "1", total_lots: "10" }] }
      ] }]
    });
    expect(normaliseAvailability(twice, fetchedAt).carparks.Z1.C.available).toBe(7);
  });

  it("rejects counts that can't be real", () => {
    const odd = Schema.decodeUnknownSync(AvailabilityResponse)({
      items: [{ carpark_data: [
        { carpark_number: "Z2", update_datetime: "2026-10-18T11:40:00", carpark_info: [{ lot_type: "C", lots_available: "12", total_lots: "10" }] },
        { carpark_number: "Z3", update_datetime: "2026-10-18T11:40:00", carpark_info: [{ lot_type: "C", lots_available: "-1", total_lots: "10" }] }
      ] }]
    });
    const result = normaliseAvailability(odd, fetchedAt);
    expect(result.carparks.Z2.C.available).toBeNull();
    expect(result.carparks.Z3.C.available).toBeNull();
  });
});

describe("carAvailability", () => {
  const now = new Date("2026-10-18T03:53:00Z");

  it("uses car lots only", () => {
    expect(carAvailability(snapshot, "TBM2", now)).toMatchObject({ state: "known", available: 232, total: 243, freshness: "current" });
  });

  it("distinguishes a carpark missing from the feed from an unknown count", () => {
    expect(carAvailability(snapshot, "NOPE", now).state).toBe("not-in-feed");
    expect(carAvailability(snapshot, "PL40", now)).toMatchObject({ state: "unknown", available: null, freshness: "stale" });
    expect(carAvailability(null, "TBM2", now).state).toBe("not-in-feed");
  });

  it("labels old records as stale even in a fresh response", () => {
    expect(recordFreshness("2026-10-18T03:30:00Z", now)).toBe("delayed");
    expect(recordFreshness("2026-08-03T16:00:00Z", now)).toBe("stale");
    expect(recordFreshness(null, now)).toBe("unknown");
  });
});

describe("feedStatus", () => {
  const ok = { lastAttemptAt: "2026-10-18T03:52:10Z", lastSuccessAt: "2026-10-18T03:52:13.000Z", lastError: null };

  it("is live right after a successful refresh", () => {
    expect(feedStatus(snapshot, ok, new Date("2026-10-18T03:54:00Z"))).toMatchObject({ state: "live", refreshError: null });
  });

  it("falls back to last-good when the snapshot is old", () => {
    expect(feedStatus(snapshot, ok, new Date("2026-10-18T04:10:00Z")).state).toBe("last-good");
  });

  it("reports a failed refresh even when a recent snapshot exists", () => {
    const failed = { ...ok, lastAttemptAt: "2026-10-18T03:53:30Z", lastError: "data.gov.sg returned HTTP 503" };
    expect(feedStatus(snapshot, failed, new Date("2026-10-18T03:54:00Z"))).toMatchObject({ state: "last-good", refreshError: "data.gov.sg returned HTTP 503" });
  });

  it("is unavailable with no snapshot", () => {
    expect(feedStatus(null, { lastAttemptAt: null, lastSuccessAt: null, lastError: "Could not reach data.gov.sg" }, new Date()).state).toBe("unavailable");
  });
});
