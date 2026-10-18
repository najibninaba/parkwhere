import { describe, expect, it } from "vitest";
import sample from "../fixtures/lta-availability.sample.json";
import { ltaAvailability, ltaName, ltaRegistry, normaliseLta, type LtaRow } from "./lta";
import { estimateCost, publishedRate } from "./tariff";

const rows = sample.value as LtaRow[];
const snapshot = normaliseLta(rows, new Date("2026-10-18T07:00:00Z"));

describe("normaliseLta (real LTA DataMall sample)", () => {
  it("keeps only LTA and URA car rows with a location", () => {
    expect(snapshot.carparks.map((carpark) => carpark.key)).toEqual(["lta:1", "lta:2", "lta:3", "ura:A0007", "ura:B0031"]);
  });

  it("leaves HDB rows to data.gov.sg, so no carpark is counted twice", () => {
    expect(snapshot.carparks.some((carpark) => carpark.carparkId === "ACB" || carpark.carparkId === "KB7")).toBe(false);
  });

  it("uses the car row, never the motorcycle row, for a URA carpark", () => {
    expect(snapshot.carparks.find((carpark) => carpark.key === "ura:A0007")).toMatchObject({ carLots: 224, name: "Angullia Park (off-street)", area: null });
  });

  it("keeps a reported zero as zero, and the fetch time as the only time", () => {
    expect(snapshot.carparks.find((carpark) => carpark.key === "ura:B0031")?.carLots).toBe(0);
    expect(snapshot.fetchedAt).toBe("2026-10-18T07:00:00.000Z");
  });

  it("treats unusable counts as unknown and keeps the first of any repeated row", () => {
    const odd = normaliseLta(
      [
        { CarParkID: "9", Agency: "LTA", LotType: "C", Location: "1.3 103.85", AvailableLots: -1, Development: "Test Mall" },
        { CarParkID: "9", Agency: "LTA", LotType: "C", Location: "1.3 103.85", AvailableLots: 50, Development: "Test Mall" },
        { CarParkID: "10", Agency: "LTA", LotType: "C", Location: "51.5 -0.12", AvailableLots: 5, Development: "Not Singapore" }
      ],
      new Date()
    );
    expect(odd.carparks).toHaveLength(1);
    expect(odd.carparks[0].carLots).toBeNull();
  });

  it("tidies names without touching mixed-case ones", () => {
    expect(ltaName("Suntec City")).toBe("Suntec City");
    expect(ltaName("ARAB ST - QUEEN ST OFF  ST")).toBe("Arab St - Queen St (off-street)");
  });
});

describe("LTA carparks in results", () => {
  const [suntec] = ltaRegistry(snapshot);

  it("never claims a time or a total for an LTA count", () => {
    expect(ltaAvailability(snapshot, "lta:1")).toEqual({ reportedBy: "LTA", state: "known", available: 967, total: null, recordedAt: null, freshness: "unknown" });
    expect(ltaAvailability(snapshot, "lta:404").state).toBe("not-in-feed");
    expect(ltaAvailability(null, "lta:1").state).toBe("not-in-feed");
  });

  it("gives no price estimate, and says where rates are", () => {
    expect(suntec).toMatchObject({ source: "lta", id: "lta:1", address: "Suntec City", carparkType: "Mall or development carpark" });
    expect(estimateCost(suntec, new Date("2026-10-19T02:00:00Z"), 120)).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/rates posted at the entrance/) });
    expect(publishedRate(suntec)).toMatch(/posted at the carpark/);
  });
});
