// HDB short-term car parking charges, as published by HDB:
//   Short-Term Parking Charges (last updated 24 Jul 2026)
//     https://www.hdb.gov.sg/parking/other-parking-matters/shortterm-parking/shortterm-parking-charges
//   Electronic Parking (last updated 12 Sep 2025)
//     https://www.hdb.gov.sg/parking/other-parking-matters/shortterm-parking/electronic-parking
//   Free Parking Scheme on Sundays and Public Holidays (last updated 22 Jan 2026)
//     https://www.hdb.gov.sg/parking/other-parking-matters/shortterm-parking/free-parking-scheme-on-sundays-and-public-holidays
//
// Only rules HDB states are modelled. Anything ambiguous returns "unavailable" with the published
// rate instead of a total.
import type { RegistryCarpark } from "./domain";
import { PUBLIC_HOLIDAYS, holidaysCover } from "./holidays";
import { hhmm, sgtParts, type SgtParts } from "./sgt";

export const TARIFF_SOURCE = "HDB short-term parking charges (page dated 24 Jul 2026)";
export const TARIFF_URL = "https://www.hdb.gov.sg/parking/other-parking-matters/shortterm-parking/shortterm-parking-charges";

export const CENTRAL_AREA_CARPARKS: ReadonlySet<string> = new Set([
  "ACB", "BBB", "BRB1", "CY", "DUXM", "HLM", "KAB", "KAM", "KAS", "PRM", "SLS", "SR1", "SR2", "TPM", "UCS", "WCB"
]);

/** Loading/unloading bays with differential pricing. They are not visitor carparks. */
export const LOADING_BAYS: ReadonlySet<string> = new Set([
  "GSML", "BRBL1", "JCML", "T55", "GEML", "KAML", "J57L", "J60L", "TPL", "EPL", "BL8L", "W4L"
]);

type DayRule = "weekdays" | "weekends" | "mon-sat" | "daily";
interface PeakWindow { days: DayRule; from: number; to: number }

/** Popular carparks with peak-hour charges. HDB's caps do not apply at these carparks. */
export const PEAK_CARPARKS: Readonly<Record<string, { label: string; windows: PeakWindow[] }>> = (() => {
  const acbCy = { label: "Weekdays 10am to 6pm, weekends 8am to 7pm", windows: [{ days: "weekdays", from: hhmm(10), to: hhmm(18) }, { days: "weekends", from: hhmm(8), to: hhmm(19) }] as PeakWindow[] };
  const se = { label: "Monday to Saturday, 10am to 10pm", windows: [{ days: "mon-sat", from: hhmm(10), to: hhmm(22) }] as PeakWindow[] };
  const mp = { label: "Daily, 8am to 8pm", windows: [{ days: "daily", from: hhmm(8), to: hhmm(20) }] as PeakWindow[] };
  const hg = { label: "Weekdays 11am to 8pm, weekends 9am to 8pm", windows: [{ days: "weekdays", from: hhmm(11), to: hhmm(20) }, { days: "weekends", from: hhmm(9), to: hhmm(20) }] as PeakWindow[] };
  return {
    ACB: acbCy, CY: acbCy, SE21: se, SE22: se,
    SE24: { label: "Daily, 10am to 10pm", windows: [{ days: "daily", from: hhmm(10), to: hhmm(22) }] },
    MP14: mp, MP15: mp, MP16: mp, HG9: hg, HG9T: hg, HG15: hg, HG16: hg
  };
})();

const DAY_START = hhmm(7);
const NIGHT_START = hhmm(22, 30);
const CENTRAL_PEAK_END = hhmm(17);
const GRACE_MINUTES = 15;
const NIGHT_CAP_CENTS = 500;
const DAY_CAP_CENTS = { central: 2000, other: 1200 };
export const MAX_STAY_MINUTES = 24 * 60;

export interface CostLine { label: string; cents: number }

export type CostEstimate =
  | { kind: "estimate"; totalCents: number; lines: CostLine[]; notes: string[] }
  | { kind: "unavailable"; reason: string; publishedRate: string }
  | { kind: "not-allowed"; reason: string; publishedRate: string };

type TariffCarpark = Pick<RegistryCarpark, "source" | "id" | "parkingSystem" | "shortTermParking" | "freeParking" | "nightParking">;

const isHdb = (carpark: Pick<RegistryCarpark, "source">) => (carpark.source ?? "hdb") === "hdb";
const NOT_COVERED = "Rates for this carpark aren't covered yet. Check the rates posted at the entrance.";

export function publishedRate(carpark: Pick<RegistryCarpark, "source" | "id">): string {
  if (!isHdb(carpark)) return "Not published here. Rates are posted at the carpark.";
  const base = CENTRAL_AREA_CARPARKS.has(carpark.id)
    ? "$1.20 per half-hour from 7am to 5pm, Mon to Sat. $0.60 per half-hour at other times"
    : "$0.60 per half-hour";
  const peak = PEAK_CARPARKS[carpark.id];
  if (!peak) return base;
  const peakRate = CENTRAL_AREA_CARPARKS.has(carpark.id) ? "$1.40 per half-hour (7am to 5pm, Mon to Sat) or $0.80" : "$0.80 per half-hour";
  return `${base}; peak ${peakRate} (${peak.label})`;
}

/** Short-term parking hours from the registry, as [from, to) minutes, or null for whole day. */
function shortTermWindow(value: string): [number, number] | null | "none" | "unknown" {
  switch (value) {
    case "WHOLE DAY": return null;
    case "7AM-10.30PM": return [DAY_START, NIGHT_START];
    case "7AM-7PM": return [DAY_START, hhmm(19)];
    case "NO": return "none";
    default: return "unknown";
  }
}

/** Free Parking Scheme start time on Sundays and public holidays, or null if not in the scheme. */
function freeParkingStart(value: string): number | null | "unknown" {
  switch (value) {
    case "NO": return null;
    case "SUN & PH FR 7AM-10.30PM": return DAY_START;
    case "SUN & PH FR 1PM-10.30PM": return hhmm(13);
    default: return "unknown";
  }
}

const isWeekend = (parts: SgtParts) => parts.weekday === 0 || parts.weekday === 6;
const dayMatches = (rule: DayRule, parts: SgtParts) =>
  rule === "daily" || (rule === "weekends" ? isWeekend(parts) : rule === "weekdays" ? !isWeekend(parts) : parts.weekday !== 0);

const inPeak = (id: string, parts: SgtParts) =>
  PEAK_CARPARKS[id]?.windows.some((window) => dayMatches(window.days, parts) && parts.minute >= window.from && parts.minute < window.to) ?? false;

const formatClock = (minute: number) => {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}.${String(m).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
};

/**
 * Estimated charge for one continuous car stay at one HDB carpark.
 * Electronic carparks charge per minute (2¢ a minute, or 4¢ in the Central Area's 7am–5pm Mon–Sat band),
 * so every total here is exact to the cent under HDB's published rules.
 */
export function estimateCost(carpark: TariffCarpark, arrival: Date, durationMinutes: number): CostEstimate {
  const rate = publishedRate(carpark);
  const unavailable = (reason: string): CostEstimate => ({ kind: "unavailable", reason, publishedRate: rate });

  if (!isHdb(carpark)) return unavailable(NOT_COVERED);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > MAX_STAY_MINUTES) {
    return unavailable("Choose a stay between 1 minute and 24 hours.");
  }
  if (LOADING_BAYS.has(carpark.id)) return unavailable("This is a loading/unloading bay with its own charges.");
  if (carpark.parkingSystem !== "ELECTRONIC PARKING") {
    return unavailable("Coupon and Parking.sg charges are not estimated yet.");
  }
  const window = shortTermWindow(carpark.shortTermParking);
  if (window === "none") return { kind: "not-allowed", reason: "No short-term parking at this carpark.", publishedRate: rate };
  if (window === "unknown") return unavailable("This carpark's short-term parking hours are not recognised.");
  const freeStart = freeParkingStart(carpark.freeParking);
  if (freeStart === "unknown") return unavailable("This carpark's free parking hours are not recognised.");

  const central = CENTRAL_AREA_CARPARKS.has(carpark.id);
  const peakCarpark = carpark.id in PEAK_CARPARKS;
  const start = Math.floor(arrival.getTime() / 60_000) * 60_000;

  // Per 7am-to-7am parking day: charges in the day band (7am–10.30pm) and the night band (10.30pm–7am).
  const days = new Map<string, { day: number; night: number }>();
  let freeMinutes = 0;
  let sawHoliday = false;

  for (let i = 0; i < durationMinutes; i += 1) {
    const parts = sgtParts(start + i * 60_000);
    if (!holidaysCover(parts.date)) return unavailable("Public holidays for that date are not published yet.");
    const holiday = PUBLIC_HOLIDAYS.has(parts.date);
    sawHoliday ||= holiday;

    if (window && (parts.minute < window[0] || parts.minute >= window[1])) {
      return {
        kind: "not-allowed",
        reason: `Short-term parking here is only from ${formatClock(window[0])} to ${formatClock(window[1])}.`,
        publishedRate: rate
      };
    }
    if (peakCarpark && (holiday || inPeak(carpark.id, parts))) {
      return unavailable(holiday ? "Peak-hour charges on public holidays are not published." : "Your stay includes peak hours. Peak-hour charges aren't estimated yet.");
    }

    const dayBand = parts.minute >= DAY_START && parts.minute < NIGHT_START;
    const parkingDay = sgtParts(start + i * 60_000 - DAY_START * 60_000).date;
    const totals = days.get(parkingDay) ?? { day: 0, night: 0 };
    days.set(parkingDay, totals);

    if (freeStart !== null && (parts.weekday === 0 || holiday) && parts.minute >= freeStart && parts.minute < NIGHT_START) {
      freeMinutes += 1;
      continue;
    }
    const centralBand = central && parts.weekday !== 0 && parts.minute >= DAY_START && parts.minute < CENTRAL_PEAK_END;
    if (centralBand && holiday) return unavailable("HDB does not say which Central Area rate applies on public holidays.");
    const cents = centralBand ? 4 : 2;
    if (dayBand) totals.day += cents;
    else totals.night += cents;
  }

  if (durationMinutes <= GRACE_MINUTES) {
    return {
      kind: "estimate",
      totalCents: 0,
      lines: [{ label: `Within the ${GRACE_MINUTES}-minute grace period`, cents: 0 }],
      notes: ["Electronic carparks don't charge if you exit within 15 minutes of entry."]
    };
  }

  const lines: CostLine[] = [];
  const notes: string[] = ["Charged per minute by the Electronic Parking System."];
  let total = 0;
  const dayCap = central ? DAY_CAP_CENTS.central : DAY_CAP_CENTS.other;
  for (const { day, night } of days.values()) {
    if (peakCarpark) {
      total += day + night;
      continue;
    }
    const cappedDay = Math.min(day, dayCap);
    const cappedNight = carpark.nightParking ? Math.min(night, NIGHT_CAP_CENTS) : night;
    const subtotal = carpark.nightParking ? Math.min(cappedDay + cappedNight, dayCap) : cappedDay + cappedNight;
    if (cappedDay < day) notes.push(`Day cap of $${(dayCap / 100).toFixed(0)} applied.`);
    if (cappedNight < night) notes.push("Night cap of $5 (10.30pm to 7am) applied.");
    if (subtotal < cappedDay + cappedNight) notes.push(`Whole-day cap of $${(dayCap / 100).toFixed(0)} applied.`);
    total += subtotal;
  }
  const charged = durationMinutes - freeMinutes;
  if (charged > 0) lines.push({ label: `${charged} charged minute${charged === 1 ? "" : "s"}`, cents: total });
  if (freeMinutes > 0) {
    lines.push({ label: `${freeMinutes} free minute${freeMinutes === 1 ? "" : "s"} (Sunday/public holiday scheme)`, cents: 0 });
    notes.push("Free parking doesn't cover lots reserved for season holders (red or red-and-white lines).");
  }
  if (sawHoliday) notes.push("Includes a public holiday.");
  if (peakCarpark) notes.push("HDB's daily and night caps don't apply at peak-hour carparks.");
  return { kind: "estimate", totalCents: total, lines, notes: [...new Set(notes)] };
}
