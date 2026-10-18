import { describe, expect, it } from "vitest";
import { parseSgtLocal } from "./sgt";
import { estimateCost, publishedRate, type CostEstimate } from "./tariff";

type Carpark = Parameters<typeof estimateCost>[0];

const ordinary: Carpark = { id: "X1", parkingSystem: "ELECTRONIC PARKING", shortTermParking: "WHOLE DAY", freeParking: "NO", nightParking: true };
const fps: Carpark = { ...ordinary, id: "X2", freeParking: "SUN & PH FR 7AM-10.30PM" };
const fpsAfternoon: Carpark = { ...ordinary, id: "X3", freeParking: "SUN & PH FR 1PM-10.30PM" };
const central: Carpark = { ...ordinary, id: "HLM" }; // Central Area, not a peak-hour carpark
const dayOnly: Carpark = { ...ordinary, id: "X4", shortTermParking: "7AM-10.30PM", nightParking: false };
const coupon: Carpark = { ...ordinary, id: "X5", parkingSystem: "COUPON PARKING" };
const peak: Carpark = { ...ordinary, id: "SE24" }; // Daily 10am–10pm peak

const at = (local: string) => {
  const date = parseSgtLocal(local);
  if (!date) throw new Error(`bad test time ${local}`);
  return date;
};
const total = (estimate: CostEstimate) => {
  if (estimate.kind !== "estimate") throw new Error(`expected an estimate, got ${estimate.kind}: ${estimate.reason}`);
  return estimate.totalCents;
};

// 2026-10-19 is a Monday; 2026-10-18 a Sunday; 2026-12-25 (Friday) a public holiday.
describe("estimateCost at electronic HDB carparks", () => {
  it("charges $0.60 per half-hour by the minute outside the Central Area", () => {
    expect(total(estimateCost(ordinary, at("2026-10-19T10:00"), 120))).toBe(240);
    expect(total(estimateCost(ordinary, at("2026-10-19T10:00"), 20))).toBe(40);
  });

  it("charges nothing within the 15-minute grace period, and from entry after it", () => {
    expect(total(estimateCost(ordinary, at("2026-10-19T10:00"), 15))).toBe(0);
    expect(total(estimateCost(ordinary, at("2026-10-19T10:00"), 16))).toBe(32);
  });

  it("uses the Central Area $1.20 rate only from 7am to 5pm, Monday to Saturday", () => {
    expect(total(estimateCost(central, at("2026-10-19T16:00"), 120))).toBe(60 * 4 + 60 * 2);
    expect(total(estimateCost(central, at("2026-10-18T09:00"), 120))).toBe(240); // Sunday
    expect(total(estimateCost(central, at("2026-10-17T06:00"), 120))).toBe(60 * 2 + 60 * 4); // Saturday from 6am
  });

  it("caps 10.30pm–7am at $5 at night-parking carparks (HDB's midnight to 6am example)", () => {
    const estimate = estimateCost(ordinary, at("2026-10-20T00:00"), 360);
    expect(total(estimate)).toBe(500);
    expect(estimate.kind === "estimate" && estimate.notes.join(" ")).toMatch(/Night cap/);
  });

  it("caps day parking at $12 outside and $20 inside the Central Area", () => {
    expect(total(estimateCost(dayOnly, at("2026-10-19T07:00"), 930))).toBe(1200);
    expect(total(estimateCost(central, at("2026-10-19T07:00"), 720))).toBe(2000);
  });

  it("caps a whole 7am-to-7am day at $12 outside the Central Area", () => {
    expect(total(estimateCost(ordinary, at("2026-10-19T07:00"), 1440))).toBe(1200);
  });

  it("applies caps per 7am-to-7am parking day across midnight", () => {
    // 22:00–22:30 (60¢) + night 22:30–07:00 (1020¢ capped to 500¢) + 07:00–08:00 next day (120¢)
    expect(total(estimateCost(ordinary, at("2026-10-19T22:00"), 600))).toBe(560 + 120);
  });

  it("is free 7am–10.30pm on Sundays and public holidays at Free Parking Scheme carparks", () => {
    expect(total(estimateCost(fps, at("2026-10-18T10:00"), 180))).toBe(0);
    expect(total(estimateCost(fps, at("2026-12-25T10:00"), 120))).toBe(0);
    expect(total(estimateCost(fps, at("2026-10-18T21:00"), 120))).toBe(60); // only 22:30–23:00 charged
    expect(total(estimateCost(ordinary, at("2026-10-18T10:00"), 60))).toBe(120); // not in the scheme
  });

  it("respects the 1pm start of the afternoon free parking variant", () => {
    expect(total(estimateCost(fpsAfternoon, at("2026-10-18T11:00"), 180))).toBe(240);
  });

  it("refuses stays outside a carpark's short-term parking hours", () => {
    const estimate = estimateCost(dayOnly, at("2026-10-19T22:00"), 60);
    expect(estimate.kind).toBe("not-allowed");
    expect(estimate.kind !== "estimate" && estimate.reason).toMatch(/7am–10.30pm/);
  });

  it("gives no total where HDB's rules are incomplete", () => {
    expect(estimateCost(coupon, at("2026-10-19T10:00"), 60).kind).toBe("unavailable");
    expect(estimateCost(peak, at("2026-10-19T11:00"), 60).kind).toBe("unavailable");
    expect(estimateCost(central, at("2026-12-25T09:00"), 60).kind).toBe("unavailable"); // Central rate on a weekday PH
    expect(estimateCost(ordinary, at("2028-01-03T10:00"), 60).kind).toBe("unavailable"); // holidays not published
    expect(estimateCost({ ...ordinary, id: "T55" }, at("2026-10-19T10:00"), 60).kind).toBe("unavailable"); // loading bay
    expect(estimateCost(ordinary, at("2026-10-19T10:00"), 0).kind).toBe("unavailable");
  });

  it("estimates peak-hour carparks outside their peak window, without caps", () => {
    const estimate = estimateCost(peak, at("2026-10-19T07:00"), 120);
    expect(total(estimate)).toBe(240);
    expect(estimate.kind === "estimate" && estimate.notes.join(" ")).toMatch(/caps don't apply/);
  });

  it("describes the published rate for every carpark", () => {
    expect(publishedRate(ordinary)).toBe("$0.60 per half-hour");
    expect(publishedRate(central)).toMatch(/\$1\.20 per half-hour 7am–5pm Mon–Sat/);
    expect(publishedRate(peak)).toMatch(/peak \$0\.80 per half-hour \(Daily 10am–10pm\)/);
  });
});
