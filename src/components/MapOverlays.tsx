import type { OverviewResponse } from "../../shared/domain";
import { FEED_LIVE_MS } from "../../shared/availability";
import { age } from "../format";

const count = new Intl.NumberFormat("en-SG");

/** The overview's colours describe "now" only while its feed is live and was fetched in the last few minutes. */
export function overviewIsCurrent(overview: OverviewResponse | null, now: number): boolean {
  if (!overview || overview.feed.state !== "live" || !overview.feed.fetchedAt) return false;
  return now - new Date(overview.feed.fetchedAt).getTime() <= FEED_LIVE_MS;
}

/** Extra wording when the LTA feed behind the mall and URA dots is failing or out of date. */
function ltaNote(overview: OverviewResponse): string {
  const lta = overview.lta;
  if (!lta) return "";
  if (lta.state === "unavailable") return " · mall and URA counts unavailable";
  if (lta.state === "last-good" || lta.refreshError) return " · mall and URA counts out of date";
  return "";
}

/** One honest sentence about the live data behind the landing map. */
export function LiveLine({ overview, failed, now }: { overview: OverviewResponse | null; failed: boolean; now: number }) {
  if (!overview && failed) {
    return (
      <p className="map-chip map-live">
        <span className="live-dot live-dot-off" aria-hidden="true" />
        Couldn't load counts. Search still works.
      </p>
    );
  }
  if (!overview) {
    return (
      <p className="map-chip map-live" aria-live="polite">
        <span className="live-dot live-dot-waiting" aria-hidden="true" />
        Checking HDB counts…
      </p>
    );
  }
  const { feed, counts } = overview;
  const live = overviewIsCurrent(overview, now);
  if (feed.state === "unavailable" || counts.reporting === 0) {
    return (
      <p className="map-chip map-live">
        <span className="live-dot live-dot-off" aria-hidden="true" />
        HDB counts are unavailable. Carparks are still shown.{ltaNote(overview)}
      </p>
    );
  }
  if (!live) {
    // Old data: no "now" claim, and the map greys its dots (ParkMap overviewCurrent).
    return (
      <p className="map-chip map-live">
        <span className="live-dot live-dot-off" aria-hidden="true" />
        <span>
          HDB counts are out of date
          <span className="map-chip-meta">
            {" "}
            · last checked {age(feed.fetchedAt, now)}
            {feed.refreshError || failed ? " · latest check failed" : ""}
            {ltaNote(overview)}
          </span>
        </span>
      </p>
    );
  }
  if (failed || feed.refreshError) {
    // Recent counts, but the latest refresh failed: say so, and don't call them "now".
    return (
      <p className="map-chip map-live">
        <span className="live-dot live-dot-off" aria-hidden="true" />
        <span>
          <strong className="num">{count.format(counts.withSpaces)}</strong> HDB carparks had car lots available when last checked, {age(feed.fetchedAt, now)}
          <span className="map-chip-meta"> · latest check failed{ltaNote(overview)}</span>
        </span>
      </p>
    );
  }
  return (
    <p className="map-chip map-live">
      <span className="live-dot" aria-hidden="true" />
      <span>
        <strong className="num">{count.format(counts.withSpaces)}</strong> HDB carparks have car lots available now
        <span className="map-chip-meta">
          {" "}
          · {count.format(counts.reporting)} reported in the last 15 min · checked {age(feed.fetchedAt, now)}
          {ltaNote(overview)}
        </span>
      </span>
    </p>
  );
}

const LEGEND = [
  ["plenty", "50+"],
  ["some", "10-49"],
  ["few", "1-9"],
  ["full", "Full"],
  ["unknown", "No recent count"]
] as const;

export function MapLegend() {
  return (
    <ul className="map-chip map-legend" aria-label="Car lots available">
      {LEGEND.map(([level, label]) => (
        <li key={level}>
          <span className={`legend-dot legend-${level}`} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}
