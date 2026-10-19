import { useState } from "react";
import type { NearbyCarpark } from "../../shared/domain";
import { CENTRAL_AREA_CARPARKS, TARIFF_SOURCE, TARIFF_URL, publishedRate, type CostEstimate } from "../../shared/tariff";
import { age, clock, distance, isCurrent, money, spaceLevel, stay } from "../format";
import { NAV_APPS, navigationUrl, type NavApp } from "../navigation";

interface Props {
  carpark: NearbyCarpark;
  rank: number;
  estimate: CostEstimate;
  durationMinutes: number;
  selected: boolean;
  onSelect: () => void;
  /** Called when a map app is opened, for the anonymous hand-off count. */
  onDirections?: (app: NavApp) => void;
  now: number;
}

const title = (value: string) => value.toLowerCase().replace(/\b([a-z])/g, (letter) => letter.toUpperCase()).replace(/\bBlk\b/g, "Blk");

const lots = new Intl.NumberFormat("en-SG");

/** Registry hours such as "7AM-10.30PM" as "7am to 10.30pm". */
const hours = (value: string) => value.toLowerCase().replace(/\s*-\s*/, " to ");

function Spaces({ carpark, now }: { carpark: NearbyCarpark; now: number }) {
  const { car } = carpark;
  const level = spaceLevel(car, now);
  if (car.state === "not-in-feed") {
    return (
      <div className={`spaces spaces-${level}`}>
        <span className="spaces-count">?</span>
        <span className="spaces-meta">No live count for this carpark</span>
      </div>
    );
  }
  if (car.state === "unknown") {
    return (
      <div className={`spaces spaces-${level}`}>
        <span className="spaces-count">?</span>
        <span className="spaces-meta">Count unknown · reported {age(car.recordedAt, now)}</span>
      </div>
    );
  }
  if (car.reportedBy === "LTA") {
    // LTA DataMall gives a count with no time and no total, so it's shown as reported and never as "now".
    return (
      <div className={`spaces spaces-${level}`}>
        <span className="spaces-count">{lots.format(car.available ?? 0)}</span>
        <span className="spaces-meta">
          car lots available, as reported
          <br />
          LTA gives no time or total
        </span>
      </div>
    );
  }
  const current = isCurrent(car, now);
  const label = current
    ? car.available === 0
      ? `full now, ${car.total} lots`
      : `car lots available, out of ${car.total}`
    : car.available === 0
      ? `full when last reported, ${car.total} lots`
      : `car lots available, out of ${car.total}, when last reported`;
  return (
    <div className={`spaces spaces-${level}`}>
      <span className="spaces-count">{lots.format(car.available ?? 0)}</span>
      <span className="spaces-meta">
        {label}
        <br />
        <span className={current ? undefined : "stale"} title={clock(car.recordedAt)}>
          {current ? "" : "⚠ "}reported {age(car.recordedAt, now)}
        </span>
      </span>
    </div>
  );
}

function Cost({ estimate, durationMinutes }: { estimate: CostEstimate; durationMinutes: number }) {
  if (estimate.kind === "estimate") {
    return (
      <div className="cost">
        <span className="cost-total">{money(estimate.totalCents)}</span>
        <span className="cost-meta">est. for {stay(durationMinutes)}</span>
      </div>
    );
  }
  return (
    <div className="cost cost-unavailable">
      <span className="cost-total">{estimate.kind === "not-allowed" ? "Not allowed" : "No estimate"}</span>
      <span className="cost-meta">{estimate.reason}</span>
    </div>
  );
}

/** What the directions point at, and what ParkWhere hasn't checked about it. */
function directionsHint(carpark: NearbyCarpark): string {
  const osm = carpark.osm;
  if (osm?.place) {
    const point = osm.atEntrance
      ? "Goes to a carpark entrance mapped on OpenStreetMap, which ParkWhere hasn't checked."
      : "Goes to a spot on a carpark mapped on OpenStreetMap, which ParkWhere hasn't checked. It may not be the entrance.";
    return `${point} Check the signs when you get there.`;
  }
  return osm?.atEntrance
    ? "Goes to an entrance mapped on OpenStreetMap, which ParkWhere hasn't verified. Look for the signs when you get there."
    : "Goes to the carpark's mapped location, which may not be its entrance.";
}

export function CarparkCard({ carpark, rank, estimate, durationMinutes, selected, onSelect, onDirections, now }: Props) {
  const [open, setOpen] = useState(false);
  const source = carpark.source ?? "hdb";
  // A carpark mapped at a public place has no access tag: it's never shown as public, only as mapped.
  const place = carpark.osm?.place;
  const tags = source === "osm" ? [
    "Mapped on OpenStreetMap",
    carpark.osm?.access === "customers" ? "Customers only" : null,
    carpark.gantryHeightM ? `Height limit ${carpark.gantryHeightM} m` : null
  ].filter((tag): tag is string => Boolean(tag)) : source !== "hdb" ? [source === "ura" ? "URA carpark" : "Mall or development", "Data: LTA DataMall"] : [
    CENTRAL_AREA_CARPARKS.has(carpark.id) ? "Central Area" : null,
    carpark.parkingSystem === "COUPON PARKING" ? "Coupon" : null,
    carpark.freeParking !== "NO" ? `Free Sun & PH, ${hours(carpark.freeParking.replace("SUN & PH FR ", ""))}` : null,
    carpark.nightParking ? "Night parking" : null,
    carpark.shortTermParking !== "WHOLE DAY" ? `Short-term parking ${hours(carpark.shortTermParking)}` : null,
    carpark.gantryHeightM ? `Height limit ${carpark.gantryHeightM} m` : null
  ].filter((tag): tag is string => Boolean(tag));
  const sub = source === "hdb" ? `${carpark.id} · ${distance(carpark.distanceM)} away · ${title(carpark.carparkType)}` : `${distance(carpark.distanceM)} away · ${carpark.carparkType}`;

  return (
    <li className={`card${selected ? " card-selected" : ""}`} id={`carpark-${carpark.id}`}>
      <button type="button" className="card-main" onClick={onSelect} aria-pressed={selected}>
        <span className="rank" aria-hidden="true">{rank}</span>
        <span className="card-head">
          {/* Registry addresses are upper case; LTA and OpenStreetMap names keep their own case ("NEX", "ION"). */}
          <span className="card-name">{source === "hdb" ? title(carpark.address) : carpark.address}</span>
          <span className="card-sub">
            {sub}
          </span>
        </span>
      </button>
      <div className="card-figures">
        <Spaces carpark={carpark} now={now} />
        <Cost estimate={estimate} durationMinutes={durationMinutes} />
      </div>
      <ul className="tags" aria-label="Carpark details">
        {tags.map((tag) => (
          <li key={tag} className="tag">{tag}</li>
        ))}
      </ul>
      <div className="card-actions">
        <details className="directions" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
          <summary className="button button-primary">Directions</summary>
          <div className="directions-menu">
            {NAV_APPS.map((app) => (
              <a key={app.id} className="button" href={navigationUrl(app.id, carpark)} target="_blank" rel="noopener noreferrer" onClick={() => onDirections?.(app.id)}>
                {app.label}
              </a>
            ))}
            <p className="hint">{directionsHint(carpark)}</p>
          </div>
        </details>
        <details className="rate">
          <summary className="button">Rates</summary>
          <div className="rate-body">
            <p>{place ? "Rates not provided." : publishedRate(carpark)}</p>
            {estimate.kind === "estimate" && estimate.notes.map((note) => <p key={note} className="hint">{note}</p>)}
            {estimate.kind === "estimate" &&
              estimate.lines.map((line) => (
                <p key={line.label} className="hint">
                  {line.label}: {money(line.cents)}
                </p>
              ))}
            {source === "hdb" && (
              <p className="hint">
                Source: <a href={TARIFF_URL} target="_blank" rel="noopener noreferrer">{TARIFF_SOURCE}</a>
              </p>
            )}
            {carpark.osm && (
              <p className="hint">
                Location from <a href={carpark.osm.url} target="_blank" rel="noopener noreferrer">OpenStreetMap</a>, which gives no counts or rates.
              </p>
            )}
          </div>
        </details>
      </div>
    </li>
  );
}
