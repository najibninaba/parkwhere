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
          <dt>Live spaces, with their age</dt>
          <dd>Car lots free right now from HDB, and how long ago each carpark last reported.</dd>
        </div>
        <div>
          <dt>Prices you can follow</dt>
          <dd>Your stay worked out from HDB’s published rules — or a plain “no estimate” when the rules don’t say.</dd>
        </div>
        <div>
          <dt>Directions in your own map app</dt>
          <dd>Google Maps, Apple Maps or Waze, straight to the carpark.</dd>
        </div>
      </dl>
      <p className="hint">Covers HDB carparks across Singapore. Malls and other carparks are coming.</p>
    </section>
  );
}
