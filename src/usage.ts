// The app's side of the anonymous usage counts (see shared/usage.ts). Nothing here identifies a visitor:
// no cookies or IDs, and nothing is stored on the device except the owner's own opt-out.
import type { CarparkSource } from "../shared/domain";
import type { DirectionsBeacon, LookupVia } from "../shared/usage";
import type { NavApp } from "./navigation";

const OPT_OUT_KEY = "parkwhere:no-stats";

/** Visiting ?nostats turns counting off in this browser (for the owner's own testing); ?stats turns it back on. */
function readOptOut(): boolean {
  const params = new URLSearchParams(window.location.search);
  try {
    if (params.has("nostats")) window.localStorage.setItem(OPT_OUT_KEY, "1");
    if (params.has("stats")) window.localStorage.removeItem(OPT_OUT_KEY);
    return params.has("nostats") || window.localStorage.getItem(OPT_OUT_KEY) === "1";
  } catch {
    // Storage blocked: the flag in the address still turns counting off for this page.
    return params.has("nostats");
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

/**
 * A reload (including the automatic one after a site update) isn't a new visit, and the destination in
 * its address isn't a new lookup.
 */
export const reloaded = typeof performance !== "undefined" && (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";

let firstSent = reloaded;

/** Only the referring site's host name leaves the browser; the server cuts it down further. */
function referrerHostName(): string {
  try {
    return document.referrer ? new URL(document.referrer).hostname.slice(0, 253) : "";
  } catch {
    return "";
  }
}

/**
 * Query parameters for an API request: c=1 when counting is allowed (the server counts nothing
 * without it), the visit details on the first request of a page load, and how the destination was
 * chosen on the first request for a destination. Empty when counting isn't allowed.
 */
export function usageParams(via?: LookupVia): string {
  if (!countingAllowed()) return "";
  const params = new URLSearchParams({ c: "1" });
  if (via) params.set("via", via);
  if (display() === "standalone") params.set("app", "1");
  if (!firstSent) {
    firstSent = true;
    params.set("first", "1");
    const ref = referrerHostName();
    if (ref) params.set("ref", ref);
  }
  return `&${params.toString()}`;
}

/** A request that carried the visit details failed, so the next one carries them again. */
export function visitNotDelivered() {
  firstSent = false;
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
