// Decoding and normalising the HDB carpark availability feed
// (https://api.data.gov.sg/v1/transport/carpark-availability).
import type { AvailabilityResponse, LotInfo } from "./feed-schema";
import type { AvailabilitySnapshot, CarAvailability, FeedStatus, LotAvailability, RecordFreshness } from "./domain";


/** Record age thresholds. The feed normally refreshes each carpark about once a minute. */
export const RECORD_CURRENT_MS = 15 * 60_000;
export const RECORD_DELAYED_MS = 60 * 60_000;
/** A snapshot older than this is no longer "live", even if the last refresh succeeded. */
export const FEED_LIVE_MS = 5 * 60_000;

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** The feed's update_datetime has no offset; HDB publishes Singapore time (UTC+8). */
export function sgtToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (LOCAL_TIME.test(trimmed)) {
    const date = new Date(`${trimmed}+08:00`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const count = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || !/^\s*\d+\s*$/.test(value)) return null;
  return Number(value);
};

function lot(info: LotInfo, recordedAt: string | null): LotAvailability {
  const available = count(info.lots_available);
  const total = count(info.total_lots);
  // A zero or missing total, or more free lots than lots, cannot be read as a real count.
  if (total === null || total === 0 || available === null || available > total) {
    return { lotType: info.lot_type.trim().toUpperCase(), available: null, total: total || null, recordedAt };
  }
  return { lotType: info.lot_type.trim().toUpperCase(), available, total, recordedAt };
}

const newer = (candidate: string | null, current: string | null) =>
  current === null || (candidate !== null && candidate > current);

/**
 * Builds a snapshot keyed by carpark and lot type. The feed sometimes splits one carpark into
 * several records (for example cars in one record and motorcycles in another, each with its own
 * time). Records are never added together: for each (carpark, lot type) the newest record wins.
 */
export function normaliseAvailability(response: AvailabilityResponse, fetchedAt: Date): AvailabilitySnapshot {
  const item = response.items[0];
  const carparks: AvailabilitySnapshot["carparks"] = {};
  for (const record of item?.carpark_data ?? []) {
    const id = record.carpark_number.trim().toUpperCase();
    if (!id) continue;
    const recordedAt = sgtToIso(record.update_datetime);
    const lots = (carparks[id] ??= {});
    for (const info of record.carpark_info) {
      const next = lot(info, recordedAt);
      const existing = lots[next.lotType];
      if (!existing || newer(next.recordedAt, existing.recordedAt)) lots[next.lotType] = next;
    }
  }
  return { fetchedAt: fetchedAt.toISOString(), feedTimestamp: sgtToIso(item?.timestamp), carparks };
}

export function recordFreshness(recordedAt: string | null, now: Date): RecordFreshness {
  if (!recordedAt) return "unknown";
  const age = now.getTime() - new Date(recordedAt).getTime();
  if (!Number.isFinite(age)) return "unknown";
  if (age <= RECORD_CURRENT_MS) return "current";
  if (age <= RECORD_DELAYED_MS) return "delayed";
  return "stale";
}

/** Car availability for one carpark. Only lot type C is used; other vehicle types are never mixed in. */
export function carAvailability(snapshot: AvailabilitySnapshot | null, carparkId: string, now: Date): CarAvailability {
  const lots = snapshot?.carparks[carparkId];
  const car = lots?.C;
  if (!car) return { reportedBy: "HDB", state: "not-in-feed", available: null, total: null, recordedAt: null, freshness: "unknown" };
  const freshness = recordFreshness(car.recordedAt, now);
  if (car.available === null) return { reportedBy: "HDB", state: "unknown", available: null, total: car.total, recordedAt: car.recordedAt, freshness };
  return { reportedBy: "HDB", state: "known", available: car.available, total: car.total, recordedAt: car.recordedAt, freshness };
}

export interface StoredStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

/** Feed status for the response. A failed refresh is always reported, even when a snapshot is served. */
export function feedStatus(snapshot: { fetchedAt: string; feedTimestamp?: string | null } | null, status: StoredStatus, now: Date): FeedStatus {
  if (!snapshot) {
    return { state: "unavailable", fetchedAt: null, feedTimestamp: null, refreshError: status.lastError, lastAttemptAt: status.lastAttemptAt };
  }
  const age = now.getTime() - new Date(snapshot.fetchedAt).getTime();
  const lastAttemptFailed = status.lastError !== null && (status.lastSuccessAt === null || (status.lastAttemptAt ?? "") > status.lastSuccessAt);
  const live = !lastAttemptFailed && age <= FEED_LIVE_MS;
  return {
    state: live ? "live" : "last-good",
    fetchedAt: snapshot.fetchedAt,
    feedTimestamp: snapshot.feedTimestamp ?? null,
    refreshError: lastAttemptFailed ? status.lastError : null,
    lastAttemptAt: status.lastAttemptAt
  };
}
