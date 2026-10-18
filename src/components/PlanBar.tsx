import { RADIUS_OPTIONS_M } from "../../shared/nearby";
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

export function PlanBar({ arrival, onArrival, durationMinutes, onDuration, radiusM, onRadius, sort, onSort }: Props) {
  return (
    <div className="plan">
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
      <fieldset className="field chips">
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
