import { useState } from "react";
import type { NearbyCarpark } from "../../shared/domain";
import { CENTRAL_AREA_CARPARKS, TARIFF_SOURCE, TARIFF_URL, publishedRate, type CostEstimate } from "../../shared/tariff";
import { age, clock, distance, isCurrent, money, spaceLevel, stay } from "../format";
import { NAV_APPS, navigationUrl } from "../navigation";

interface Props {
  carpark: NearbyCarpark;
  rank: number;
  estimate: CostEstimate;
  durationMinutes: number;
  selected: boolean;
  onSelect: () => void;
  now: number;
}

const title = (value: string) => value.toLowerCase().replace(/\b([a-z])/g, (letter) => letter.toUpperCase()).replace(/\bBlk\b/g, "Blk");

function Spaces({ carpark, now }: { carpark: NearbyCarpark; now: number }) {
  const { car } = carpark;
  const level = spaceLevel(car, now);
  if (car.state === "not-in-feed") {
    return (
      <div className={`spaces spaces-${level}`}>
        <span className="spaces-count">—</span>
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
  const current = isCurrent(car, now);
  const label = current
    ? car.available === 0
      ? `full now, ${car.total} lots`
      : `car lots free of ${car.total}`
    : car.available === 0
      ? `full when last reported, ${car.total} lots`
      : `car lots free of ${car.total}, when last reported`;
  return (
    <div className={`spaces spaces-${level}`}>
      <span className="spaces-count">{car.available}</span>
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

export function CarparkCard({ carpark, rank, estimate, durationMinutes, selected, onSelect, now }: Props) {
  const [open, setOpen] = useState(false);
  const tags = [
    CENTRAL_AREA_CARPARKS.has(carpark.id) ? "Central Area" : null,
    carpark.parkingSystem === "COUPON PARKING" ? "Coupon" : null,
    carpark.freeParking !== "NO" ? `Free ${carpark.freeParking.replace("SUN & PH FR ", "Sun & PH ").toLowerCase()}` : null,
    carpark.nightParking ? "Night parking" : null,
    carpark.shortTermParking !== "WHOLE DAY" ? `Short-term ${carpark.shortTermParking.toLowerCase()}` : null,
    carpark.gantryHeightM ? `Gantry ${carpark.gantryHeightM} m` : null
  ].filter((tag): tag is string => Boolean(tag));

  return (
    <li className={`card${selected ? " card-selected" : ""}`} id={`carpark-${carpark.id}`}>
      <button type="button" className="card-main" onClick={onSelect} aria-pressed={selected}>
        <span className="rank" aria-hidden="true">{rank}</span>
        <span className="card-head">
          <span className="card-name">{title(carpark.address)}</span>
          <span className="card-sub">
            {carpark.id} · {distance(carpark.distanceM)} away · {title(carpark.carparkType)}
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
              <a key={app.id} className="button" href={navigationUrl(app.id, carpark)} target="_blank" rel="noopener noreferrer">
                {app.label}
              </a>
            ))}
            <p className="hint">Goes to the carpark's mapped location, which may not be its entrance.</p>
          </div>
        </details>
        <details className="rate">
          <summary className="button">Rates</summary>
          <div className="rate-body">
            <p>{publishedRate(carpark)}</p>
            {estimate.kind === "estimate" && estimate.notes.map((note) => <p key={note} className="hint">{note}</p>)}
            {estimate.kind === "estimate" &&
              estimate.lines.map((line) => (
                <p key={line.label} className="hint">
                  {line.label}: {money(line.cents)}
                </p>
              ))}
            <p className="hint">
              Source: <a href={TARIFF_URL} target="_blank" rel="noopener noreferrer">{TARIFF_SOURCE}</a>
            </p>
          </div>
        </details>
      </div>
    </li>
  );
}
