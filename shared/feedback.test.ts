import { describe, expect, it } from "vitest";
import type { CarAvailability } from "./domain";
import { checkFeedback, cleanNote, noteHash, printable, purgeCutoffs, reasonsFor, receivedOn, shownText, yearBefore } from "./feedback";

const check = (body: Record<string, unknown>) => checkFeedback(JSON.stringify(body));
const hdb = { kind: "carpark", source: "hdb", carparkId: "ACB" };

describe("reasonsFor", () => {
  it("offers rates only on HDB cards and 'isn't a carpark' only on OpenStreetMap cards", () => {
    expect(reasonsFor("hdb")).toEqual(["location", "closed", "access", "count", "rates", "other"]);
    expect(reasonsFor("lta")).toEqual(["location", "closed", "access", "count", "other"]);
    expect(reasonsFor("ura")).toEqual(reasonsFor("lta"));
    expect(reasonsFor("osm")).toEqual(["location", "closed", "access", "not-carpark", "other"]);
  });
});

describe("checkFeedback", () => {
  it("accepts a carpark report and trims the note", () => {
    expect(check({ ...hdb, reason: "closed", note: "  Gantry closed for works\r\n", appVersion: "2026-10-20.abc1234" })).toEqual({
      kind: "ok",
      report: { kind: "carpark", reason: "closed", carparkId: "ACB", source: "hdb", shown: null, note: "Gantry closed for works", appVersion: "2026-10-20.abc1234" }
    });
  });

  it("stores no note when it's empty", () => {
    const result = check({ ...hdb, reason: "location", note: "   " });
    expect(result.kind === "ok" && result.report.note).toBeNull();
  });

  it("drops a report whose hidden field is filled in", () => {
    expect(check({ ...hdb, reason: "closed", website: "http://spam.example" })).toEqual({ kind: "bait" });
  });

  it("rejects reasons that don't fit the source", () => {
    expect(check({ ...hdb, source: "lta", carparkId: "lta:1", reason: "rates" })).toMatchObject({ kind: "invalid", message: "That reason doesn't apply to this carpark." });
    expect(check({ ...hdb, source: "osm", carparkId: "osm:way/1", reason: "count", shown: "No live count" }).kind).toBe("invalid");
    expect(check({ ...hdb, reason: "not-carpark" }).kind).toBe("invalid");
    expect(check({ ...hdb, reason: "idea", note: "x" }).kind).toBe("invalid");
    expect(check({ ...hdb, reason: "nonsense" })).toMatchObject({ message: "Choose what's wrong." });
  });

  it("needs a note for Something else, and for general feedback", () => {
    expect(check({ ...hdb, reason: "other" })).toMatchObject({ kind: "invalid", message: "Add a note to say what's wrong." });
    expect(check({ kind: "general", reason: "idea", note: " " })).toMatchObject({ kind: "invalid", message: "Write a message." });
    expect(check({ kind: "general", reason: "missing", note: "Behind Blk 12" }).kind).toBe("ok");
  });

  it("keeps notes to their limit: 500 for a carpark, 1,000 for general feedback", () => {
    expect(check({ ...hdb, reason: "other", note: "a".repeat(500) }).kind).toBe("ok");
    expect(check({ ...hdb, reason: "other", note: "a".repeat(501) })).toMatchObject({ message: "Keep the note under 500 characters." });
    expect(check({ kind: "general", reason: "idea", note: "a".repeat(1000) }).kind).toBe("ok");
    expect(check({ kind: "general", reason: "idea", note: "a".repeat(1001) }).kind).toBe("invalid");
  });

  it("takes what the card showed only on a count report, in plain words", () => {
    expect(check({ ...hdb, reason: "count", shown: "41 car lots available out of 143, reported 20 Oct 10:02" }).kind).toBe("ok");
    expect(check({ ...hdb, reason: "count" }).kind).toBe("invalid");
    expect(check({ ...hdb, reason: "count", shown: "<script>alert(1)</script>" }).kind).toBe("invalid");
    expect(check({ ...hdb, reason: "closed", shown: "41 car lots available" }).kind).toBe("invalid");
  });

  it("rejects anything it doesn't expect", () => {
    expect(checkFeedback("not json").kind).toBe("invalid");
    expect(checkFeedback("[]").kind).toBe("invalid");
    expect(check({ ...hdb, reason: "closed", email: "me@example.com" }).kind).toBe("invalid");
    expect(check({ ...hdb, reason: "closed", carparkId: null }).kind).toBe("invalid");
    expect(check({ ...hdb, reason: "closed", source: "ion" }).kind).toBe("invalid");
    expect(check({ kind: "general", reason: "idea", note: "x", carparkId: "ACB" }).kind).toBe("invalid");
    expect(check({ ...hdb, reason: "closed", appVersion: "1.0; DROP TABLE" }).kind).toBe("invalid");
    expect(check({ ...hdb, reason: "closed", note: 42 }).kind).toBe("invalid");
  });
});

describe("cleanNote and printable", () => {
  it("removes control characters but keeps line breaks", () => {
    expect(cleanNote("a\u0000b‮c\r\nd")).toBe("abc\nd");
  });

  it("strips terminal escape sequences before printing", () => {
    expect(printable("ok\u001B[2J\u001B[31mred\u0007\nnext")).toBe("okred\nnext");
    expect(printable(null)).toBe("");
  });
});

describe("dates and retention", () => {
  it("stores the Singapore date only", () => {
    expect(receivedOn(new Date("2026-10-19T16:30:00Z"))).toBe("2026-10-20");
  });

  it("deletes 180 days after closing, and 12 months after receipt at the latest", () => {
    expect(purgeCutoffs("2026-10-20")).toEqual({ closedOnOrBefore: "2026-04-23", receivedOnOrBefore: "2025-10-20" });
    expect(yearBefore("2028-02-29")).toBe("2027-02-28");
  });
});

describe("shownText", () => {
  const car = (overrides: Partial<CarAvailability>): CarAvailability => ({
    reportedBy: "HDB",
    state: "known",
    available: 41,
    total: 143,
    recordedAt: "2026-10-20T02:02:00Z",
    freshness: "current",
    ...overrides
  });

  it("says what the card showed with a time that stays true", () => {
    expect(shownText(car({}))).toBe("41 car lots available out of 143, reported 20 Oct 10:02");
    expect(shownText(car({ reportedBy: "LTA", total: null, recordedAt: null }))).toBe("41 car lots available, as reported by LTA, no time or total");
    expect(shownText(car({ state: "not-in-feed", reportedBy: null }))).toBe("No live count");
    expect(shownText(car({ state: "unknown", available: null }))).toBe("Count unknown, reported 20 Oct 10:02");
  });

  it("passes the Worker's check", () => {
    for (const shown of [shownText(car({})), shownText(car({ reportedBy: "LTA", total: null, recordedAt: null })), shownText(car({ state: "unknown", available: null, recordedAt: null }))]) {
      expect(check({ ...hdb, reason: "count", shown }).kind).toBe("ok");
    }
  });
});

describe("noteHash", () => {
  it("treats case and spacing as the same note", async () => {
    expect(await noteHash("Gantry  closed")).toBe(await noteHash("gantry closed "));
    expect(await noteHash(null)).toBe(await noteHash(""));
    expect(await noteHash("a")).toMatch(/^[0-9a-f]{32}$/);
  });
});
