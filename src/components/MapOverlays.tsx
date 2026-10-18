import type { OverviewResponse } from "../../shared/domain";
import { FEED_LIVE_MS } from "../../shared/availability";
import { age } from "../format";

const count = new Intl.NumberFormat("en-SG");

/** One honest sentence about the live data behind the landing map. */
export function LiveLine({ overview, now }: { overview: OverviewResponse | null; now: number }) {
  if (!overview) {
    return (
      <p className="map-chip map-live" aria-live="polite">
        <span className="live-dot live-dot-waiting" aria-hidden="true" />
        Checking live HDB counts…
      </p>
    );
  }
  const { feed, counts } = overview;
  const fetchedAt = feed.fetchedAt ? new Date(feed.fetchedAt).getTime() : 0;
  const live = feed.state === "live" && now - fetchedAt <= FEED_LIVE_MS;
  if (feed.state === "unavailable" || counts.reporting === 0) {
    return (
      <p className="map-chip map-live">
        <span className="live-dot live-dot-off" aria-hidden="true" />
        Live counts unavailable. Carparks are still shown.
      </p>
    );
  }
  return (
    <p className="map-chip map-live">
      <span className={`live-dot${live ? "" : " live-dot-off"}`} aria-hidden="true" />
      <span>
        <strong className="num">{count.format(counts.withSpaces)}</strong> carparks have car spaces now
        <span className="map-chip-meta">
          {" "}
          · {count.format(counts.reporting)} reporting · {live ? "updated" : "last updated"} {age(feed.fetchedAt, now)}
        </span>
      </span>
    </p>
  );
}

const LEGEND = [
  ["plenty", "50+"],
  ["some", "10–49"],
  ["few", "1–9"],
  ["full", "Full"],
  ["unknown", "No count"]
] as const;

export function MapLegend() {
  return (
    <ul className="map-chip map-legend" aria-label="Car spaces free">
      {LEGEND.map(([level, label]) => (
        <li key={level}>
          <span className={`legend-dot legend-${level}`} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}
