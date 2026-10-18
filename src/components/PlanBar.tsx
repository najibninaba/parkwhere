import { useId, useState } from "react";
import { RADIUS_OPTIONS_M } from "../../shared/nearby";
import { toSgtLocal } from "../../shared/sgt";
import { distance, stay } from "../format";

export const STAY_OPTIONS = [30, 60, 90, 120, 180, 240, 360, 480, 720] as const;
export type SortKey = "distance" | "spaces" | "cost";

interface Props {
  arrival: string;
  onArrival: (value: string) => void;
  durationMinutes: number;
  onDuration: (value: number) => void;
  radiusM: number;
  onRadius: (value: number) => void;
  sort: SortKey;
  onSort: (value: SortKey) => void;
}

/** "Today 2:40 pm", "Tomorrow 9 am" or "Sat 18 Oct, 9 am", from a Singapore local "YYYY-MM-DDTHH:MM". */
export function arrivalLabel(arrival: string, now = new Date()): string {
  const [date, time] = arrival.split("T");
  const [h, m] = time.split(":").map(Number);
  const clock = `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
  const today = toSgtLocal(now).slice(0, 10);
  const tomorrow = toSgtLocal(new Date(now.getTime() + 86_400_000)).slice(0, 10);
  if (date === today) return `Today ${clock}`;
  if (date === tomorrow) return `Tomorrow ${clock}`;
  const day = new Intl.DateTimeFormat("en-SG", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  return `${day}, ${clock}`;
}

export function PlanBar({ arrival, onArrival, durationMinutes, onDuration, radiusM, onRadius, sort, onSort }: Props) {
  // On phones the plan collapses to one line so results come first; wide screens always show it.
  const [open, setOpen] = useState(false);
  const fieldsId = useId();
  return (
    <div className={`plan${open ? " plan-open" : ""}`}>
      <div className="plan-summary">
        <p>
          <span className="label">Plan</span> {arrivalLabel(arrival)} · {stay(durationMinutes)} · within {distance(radiusM)}
        </p>
        <button type="button" className="link" aria-expanded={open} aria-controls={fieldsId} onClick={() => setOpen((value) => !value)}>
          {open ? "Done" : "Change"}
        </button>
      </div>
      <div className="plan-fields" id={fieldsId}>
        <label className="field">
          <span className="label">Arrive</span>
          <input type="datetime-local" value={arrival} step={300} onChange={(event) => event.target.value && onArrival(event.target.value)} />
        </label>
        <label className="field">
          <span className="label">Stay</span>
          <select value={durationMinutes} onChange={(event) => onDuration(Number(event.target.value))}>
            {STAY_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {stay(minutes)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field chips">
          <legend className="label">Within</legend>
          {RADIUS_OPTIONS_M.map((radius) => (
            <button key={radius} type="button" className="chip" aria-pressed={radius === radiusM} onClick={() => onRadius(radius)}>
              {distance(radius)}
            </button>
          ))}
        </fieldset>
      </div>
      <fieldset className="field chips plan-sort">
        <legend className="label">Sort</legend>
        {(
          [
            ["distance", "Nearest"],
            ["spaces", "Most spaces"],
            ["cost", "Cheapest"]
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" className="chip" aria-pressed={sort === key} onClick={() => onSort(key)}>
            {label}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
