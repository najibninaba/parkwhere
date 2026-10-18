import type { Destination } from "./SearchBox";
import { QUICK_PICKS } from "../places";

/** First-run panel: what ParkWhere does, and the fastest ways to start. The search box sits above it. */
export function Landing({ onChoose }: { onChoose: (destination: Destination) => void }) {
  return (
    <section className="landing" aria-label="Get started">
      <div className="quick-picks">
        <span className="label" id="quick-picks-label">
          Or try
        </span>
        <ul aria-labelledby="quick-picks-label">
          {QUICK_PICKS.map((place) => (
            <li key={place.label}>
              <button type="button" className="chip chip-pick" onClick={() => onChoose(place)}>
                {place.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <dl className="promises">
        <div>
          <dt>Available car lots</dt>
          <dd>Counts from HDB and LTA. HDB counts also show when each carpark last reported.</dd>
        </div>
        <div>
          <dt>Price estimates</dt>
          <dd>Worked out from HDB’s published rates. When the rates don’t cover your stay, the card says “No estimate” and why.</dd>
        </div>
        <div>
          <dt>Directions</dt>
          <dd>Open Google Maps, Apple Maps or Waze at the carpark’s mapped location.</dd>
        </div>
      </dl>
      <p className="hint">Covers HDB carparks, and the mall and URA carparks that report counts to LTA. Mall and URA prices aren’t estimated yet.</p>
    </section>
  );
}
