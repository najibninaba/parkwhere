import { describe, expect, it } from "vitest";
import type { CarAvailability } from "./domain";
import { LEVEL_CODES, isCurrent, levelCode, spaceLevel } from "./levels";

const now = new Date("2026-10-18T07:00:00Z").getTime();
const hdb = (available: number, minutesAgo: number): CarAvailability => ({
  reportedBy: "HDB",
  state: "known",
  available,
  total: 100,
  recordedAt: new Date(now - minutesAgo * 60_000).toISOString(),
  freshness: "current"
});

describe("spaceLevel", () => {
  it("colours only counts from the last 15 minutes", () => {
    expect(spaceLevel(hdb(60, 5), now)).toBe("plenty");
    expect(spaceLevel(hdb(20, 5), now)).toBe("some");
    expect(spaceLevel(hdb(3, 5), now)).toBe("few");
    expect(spaceLevel(hdb(0, 5), now)).toBe("full");
    expect(spaceLevel(hdb(60, 40), now)).toBe("unknown");
    expect(spaceLevel(hdb(0, 600), now)).toBe("unknown");
    expect(isCurrent(hdb(1, 14), now)).toBe(true);
    expect(isCurrent(hdb(1, 16), now)).toBe(false);
  });

  it("never colours an LTA count, which has no time, and never calls a missing count full", () => {
    const lta: CarAvailability = { reportedBy: "LTA", state: "known", available: 0, total: null, recordedAt: null, freshness: "unknown" };
    expect(spaceLevel(lta, now)).toBe("unknown");
    expect(spaceLevel({ ...lta, state: "not-in-feed", available: null }, now)).toBe("unknown");
  });

  it("round-trips the compact overview codes", () => {
    for (const level of LEVEL_CODES) expect(LEVEL_CODES[levelCode(level)]).toBe(level);
  });
});
