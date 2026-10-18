// Normalising LTA DataMall's CarParkAvailabilityv2 (https://datamall.lta.gov.sg, API User Guide §2.12).
// Only Agency LTA and URA car rows are kept: HDB rows duplicate data.gov.sg's feed by carpark number
// (all 1,997 HDB car rows matched the registry within 100 m on 2026-10-18), and data.gov.sg's has
// record times and totals, which LTA's lacks.
import type { CarAvailability, LtaCarpark, LtaSnapshot, RegistryCarpark } from "./domain";
import { isInSingapore } from "./nearby";

export interface LtaRow {
  CarParkID?: unknown;
  Area?: unknown;
  Development?: unknown;
  Location?: unknown;
  AvailableLots?: unknown;
  LotType?: unknown;
  Agency?: unknown;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** "ANGULLIA PARK OFF ST" -> "Angullia Park (off-street)"; mixed-case names such as "Suntec City" are kept. */
export function ltaName(raw: string): string {
  const titled = raw === raw.toUpperCase() ? raw.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, lead: string, letter: string) => lead + letter.toUpperCase()) : raw;
  return titled.replace(/\s+/g, " ").replace(/\s*\bOff\s+St\b\.?/i, " (off-street)").trim();
}

function location(value: unknown): { lat: number; lng: number } | null {
  const parts = text(value).split(/\s+/);
  if (parts.length !== 2) return null;
  const [lat, lng] = parts.map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) && isInSingapore(lat, lng) ? { lat, lng } : null;
}

export function normaliseLta(rows: readonly unknown[], fetchedAt: Date): LtaSnapshot {
  const carparks = new Map<string, LtaCarpark>();
  for (const item of rows) {
    // The page is decoded as unknown rows; anything that isn't an object is skipped, never fatal.
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const row = item as LtaRow;
    const agency = text(row.Agency).toUpperCase();
    if ((agency !== "LTA" && agency !== "URA") || text(row.LotType).toUpperCase() !== "C") continue;
    const id = text(row.CarParkID);
    const point = location(row.Location);
    if (!id || !point) continue;
    const lots = typeof row.AvailableLots === "number" && Number.isInteger(row.AvailableLots) && row.AvailableLots >= 0 ? row.AvailableLots : null;
    const key = `${agency.toLowerCase()}:${id}`;
    // One car row per carpark is expected; if LTA ever repeats one, keep the first rather than add them up.
    if (carparks.has(key)) continue;
    carparks.set(key, {
      key,
      agency: agency as "LTA" | "URA",
      carparkId: id,
      name: ltaName(text(row.Development) || id),
      area: text(row.Area) || null,
      ...point,
      carLots: lots
    });
  }
  return { fetchedAt: fetchedAt.toISOString(), carparks: [...carparks.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

/** LTA and URA carparks in the shape the nearby search uses. HDB-only attributes are "UNKNOWN". */
export function ltaRegistry(snapshot: LtaSnapshot | null): RegistryCarpark[] {
  return (snapshot?.carparks ?? []).map((carpark) => ({
    source: carpark.agency === "URA" ? "ura" : "lta",
    id: carpark.key,
    address: carpark.name,
    lat: carpark.lat,
    lng: carpark.lng,
    carparkType: carpark.agency === "URA" ? "URA carpark" : "Mall or development carpark",
    parkingSystem: "UNKNOWN",
    shortTermParking: "UNKNOWN",
    freeParking: "UNKNOWN",
    nightParking: false,
    gantryHeightM: null,
    basement: false
  }));
}

/** LTA counts have no time and no total: they are shown as reported, never as current or as a share. */
export function ltaAvailability(snapshot: LtaSnapshot | null, key: string): CarAvailability {
  const carpark = snapshot?.carparks.find((item) => item.key === key);
  if (!carpark) return { reportedBy: "LTA", state: "not-in-feed", available: null, total: null, recordedAt: null, freshness: "unknown" };
  if (carpark.carLots === null) return { reportedBy: "LTA", state: "unknown", available: null, total: null, recordedAt: null, freshness: "unknown" };
  return { reportedBy: "LTA", state: "known", available: carpark.carLots, total: null, recordedAt: null, freshness: "unknown" };
}
