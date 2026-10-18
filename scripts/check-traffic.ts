// Marks ParkWhere's own checks (phone checks, proof, README media) so the Worker never counts them in
// the usage numbers. The header goes on ParkWhere's API requests only: on other sites' requests, such as
// Google Fonts, it would trigger a CORS preflight that they refuse.
import type { BrowserContext } from "playwright-core";

export const CHECK_HEADERS = { "x-parkwhere-check": "1" };

export async function markAsCheck(context: BrowserContext): Promise<void> {
  await context.route("**/api/**", (route) => route.continue({ headers: { ...route.request().headers(), ...CHECK_HEADERS } }));
}
