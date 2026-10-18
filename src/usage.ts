// The app's side of the anonymous usage counts (see shared/usage.ts). Nothing here identifies a visitor:
// no cookies or IDs, and nothing is stored on the device except the owner's own opt-out.
import type { CarparkSource } from "../shared/domain";
import type { DirectionsBeacon, LookupVia } from "../shared/usage";
import type { NavApp } from "./navigation";

const OPT_OUT_KEY = "parkwhere:no-stats";

/** Visiting ?nostats turns counting off in this browser (for the owner's own testing); ?stats turns it back on. */
function readOptOut(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("nostats")) window.localStorage.setItem(OPT_OUT_KEY, "1");
    if (params.has("stats")) window.localStorage.removeItem(OPT_OUT_KEY);
    return window.localStorage.getItem(OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

const optedOut = typeof window === "undefined" ? true : readOptOut();

/** False for automated browsers (CI checks, scripts), Global Privacy Control, Do Not Track or the owner's opt-out. */
export function countingAllowed(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return !optedOut && !nav.webdriver && nav.globalPrivacyControl !== true && nav.doNotTrack !== "1";
}

export const display = (): DirectionsBeacon["display"] =>
  window.matchMedia?.("(display-mode: standalone)").matches ? "standalone" : "browser";

let firstSent = false;

/**
 * Query parameters for an API request: the visit details on the first request of a page load, and how
 * the destination was chosen on the first request for a destination. Empty when counting isn't allowed.
 */
export function usageParams(via?: LookupVia): string {
  if (!countingAllowed()) return "";
  const params = new URLSearchParams();
  if (via) params.set("via", via);
  if (display() === "standalone") params.set("app", "1");
  if (!firstSent) {
    firstSent = true;
    params.set("first", "1");
    if (document.referrer) params.set("ref", document.referrer.slice(0, 200));
  }
  const query = params.toString();
  return query ? `&${query}` : "";
}

/** Counts a directions hand-off. `first` marks the first one for the current destination. */
export function countDirections(app: NavApp, source: CarparkSource, first: boolean) {
  if (!countingAllowed() || typeof navigator.sendBeacon !== "function") return;
  const beacon: DirectionsBeacon = { event: "directions", app, source, first, display: display() };
  try {
    navigator.sendBeacon("/api/event", new Blob([JSON.stringify(beacon)], { type: "text/plain" }));
  } catch {
    // Counting is best effort; directions still open.
  }
}
