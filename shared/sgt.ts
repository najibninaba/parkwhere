// Singapore time helpers. Singapore has used UTC+8 without daylight saving since 1982.

export const SGT_OFFSET_MS = 8 * 60 * 60_000;

export interface SgtParts {
  /** YYYY-MM-DD in Singapore. */
  date: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** Minutes since local midnight. */
  minute: number;
}

export function sgtParts(instant: Date | number): SgtParts {
  const local = new Date((typeof instant === "number" ? instant : instant.getTime()) + SGT_OFFSET_MS);
  return {
    date: local.toISOString().slice(0, 10),
    weekday: local.getUTCDay(),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes()
  };
}

/** Parses "YYYY-MM-DDTHH:MM" as Singapore local time. */
export function parseSgtLocal(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats an instant as "YYYY-MM-DDTHH:MM" in Singapore local time (for datetime-local inputs). */
export function toSgtLocal(instant: Date): string {
  return new Date(instant.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 16);
}

export const hhmm = (hours: number, minutes = 0) => hours * 60 + minutes;
