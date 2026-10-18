# ParkWhere

Find an HDB carpark near where you're going in Singapore. ParkWhere shows how many car lots are free, how old each count is and what your stay should cost. Directions open in Google Maps, Apple Maps or Waze.

The app is one Cloudflare Worker that serves a Vite + React PWA and a small API:

- `GET /api/nearby?lat=&lng=&radius=300|500|1000` returns HDB carparks near a point, with car availability and feed status.
- `GET /api/search?q=` searches for places through OneMap when it's configured, and HDB carpark addresses otherwise.
- `GET /health` returns 200 only when the availability feed is live.

## Run it

```sh
pnpm install
pnpm exec wrangler d1 migrations apply parkwhere-production --local   # once
pnpm dev                     # http://localhost:5173
```

Verify with `pnpm check` (typecheck, tests and build). For the phone check, run `pnpm check:mobile` while `pnpm dev` is running; it needs Google Chrome installed.

## How the data works

- **Availability** comes from data.gov.sg's [Carpark Availability](https://data.gov.sg/datasets/d_ca933a644e55d34fe21f28b8052fac63/view) (`api.data.gov.sg/v1/transport/carpark-availability`) and needs no key.
  - The Worker keeps the last good snapshot in D1 and refreshes it when a request finds it more than a minute old.
  - A snapshot up to 5 minutes old is served while it refreshes in the background. Older than that, the request waits for the refresh.
  - A claim in D1 allows only one refresh every 30 seconds across all isolates.
  - Transient errors are retried twice with backoff.
  - When a refresh fails, the app shows the last good data and says so.
- **Carpark locations and attributes** come from the [HDB Carpark Information](https://data.gov.sg/datasets/d_23f946fa557947f93a8043bbef41dd09/view) registry, which is updated monthly.
  - It is bundled as `worker/registry.json`, converted from SVY21 to WGS84.
  - Refresh it with `pnpm registry` and redeploy.
- **Freshness** is reported separately for the response (when we fetched it) and for each carpark's own record, which can be hours or months older.
  - A car count over 15 minutes old is flagged; one over an hour old is marked stale.
  - Unknown counts are never shown as 0.
- **Costs** are worked out in the browser from HDB's published short-term charges (`shared/tariff.ts`).
  - Covered: per-minute electronic charging, the 15-minute grace period, Central Area hours, the $5 night cap, the $12/$20 day caps, free parking on Sundays and public holidays, short-term parking hours, and MOM's 2026–2027 public holidays.
  - Where HDB's rules are incomplete, the app shows the published rate and "No estimate" instead of a total. That covers coupon carparks, stays during peak-hour windows, Central Area weekday public holidays, and years whose holidays aren't published yet.

## Deploying

This is prepared but not done. Each step needs your go-ahead:

1. `pnpm exec wrangler d1 create parkwhere-production`, then put the returned `database_id` in `wrangler.jsonc`.
2. `pnpm exec wrangler d1 migrations apply parkwhere-production --remote`
3. `pnpm run deploy` (`pnpm deploy` is a built-in pnpm command). This creates the Worker `parkwhere` and the custom domain `parkwhere.bijan.app`, which adds a DNS record to the `bijan.app` zone.

Optional secrets, set with `wrangler secret put <NAME>` and never pasted anywhere else:

| Secret | Why |
|---|---|
| `ONEMAP_EMAIL`, `ONEMAP_PASSWORD` | Turns on real place search. Register a free OneMap API account at https://www.onemap.gov.sg/apidocs/register. Without it, search only matches HDB carpark addresses, and "Near me" still works. |
| `DATA_GOV_SG_API_KEY` | Raises data.gov.sg rate limits. Not needed at current traffic. |

For local OneMap testing, put the same names in `.dev.vars`, which git ignores.

## Not done yet

- Place search needs the OneMap account above. Until then the app searches HDB carpark addresses and says so.
- Only HDB carparks are covered. Malls and other commercial carparks need LTA DataMall or URA access, which both need keys.
- There are no estimates for coupon carparks, stays during peak-hour windows, or Central Area weekday public holidays.
- Loading/unloading bays are left out of results.
- Season-parking-only carparks (`short_term_parking = NO`) are left out.
- Distances are straight-line from the destination, not walking routes.
- Directions go to the registry point, not a verified entrance.
- The public holiday list needs a manual update when MOM publishes 2028.
- There's no dark mode yet.

## Sources and licences

Contains information from Carpark Availability and HDB Carpark Information, accessed from data.gov.sg under the [Singapore Open Data Licence v1.0](https://data.gov.sg/open-data-licence). Maps are © OneMap contributors and the Singapore Land Authority. Charges follow HDB's published short-term parking pages. ParkWhere is not affiliated with HDB, SLA or GovTech.
