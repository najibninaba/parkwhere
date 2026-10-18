# ParkWhere

Find a carpark near where you're going in Singapore: every HDB carpark, plus the mall and URA carparks that report to LTA. ParkWhere shows how many car lots are free, how old each count is and what your stay should cost. Directions open in Google Maps, Apple Maps or Waze.

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
- **Mall and URA carparks** come from LTA DataMall's [CarParkAvailabilityv2](https://datamall.lta.gov.sg/content/datamall/en/dynamic-data.html), using the `LTA_DATAMALL_ACCOUNT_KEY` Worker secret.
  - The Worker fetches every page about once a minute and keeps its own last-good snapshot in D1 (`lta_snapshot`, `lta_status`). If LTA fails, HDB results are unaffected, and the reverse holds too.
  - HDB rows in LTA's feed are dropped. On 2026-10-18, all 1,997 of them matched HDB registry numbers within 100 m, and data.gov.sg's HDB feed has record times and totals.
  - Only car rows (`LotType` C) from Agency LTA (malls, attractions) and URA (off-street carparks) are kept, about 130 carparks.
  - LTA gives **no record time and no total**. These counts are labelled "as reported, LTA gives no time or total", drawn grey on the map, ranked after current HDB counts, and never priced ("No estimate: check the rates posted at the entrance").
- **Carpark locations and attributes** come from the [HDB Carpark Information](https://data.gov.sg/datasets/d_23f946fa557947f93a8043bbef41dd09/view) registry, which is updated monthly.
  - It is bundled as `worker/registry.json`, converted from SVY21 to WGS84.
  - Refresh it with `pnpm registry` and redeploy.
- **Freshness** is reported separately for the response (when we fetched it) and for each carpark's own record, which can be hours or months older.
  - A car count over 15 minutes old is flagged; one over an hour old is marked stale.
  - Unknown counts are never shown as 0.
- **Costs** are worked out in the browser from HDB's published short-term charges (`shared/tariff.ts`).
  - Covered: per-minute electronic charging, the 15-minute grace period, Central Area hours, the $5 night cap, the $12/$20 day caps, free parking on Sundays and public holidays, short-term parking hours, and MOM's 2026–2027 public holidays.
  - Where HDB's rules are incomplete, the app shows the published rate and "No estimate" instead of a total. That covers coupon carparks, stays during peak-hour windows, Central Area weekday public holidays, and years whose holidays aren't published yet.

## Environments and deploys

| | Production | Staging | PR previews |
|---|---|---|---|
| URL | https://parkwhere.bijan.app | https://parkwhere-staging.bijan.app | `https://pr-<n>-parkwhere-staging.najibninaba.workers.dev` |
| Worker | `parkwhere` | `parkwhere-staging` | preview versions of `parkwhere-staging` |
| D1 | `parkwhere-production` | `parkwhere-staging` | staging's |
| Deployed by | `Deploy` workflow, after staging passes | `Deploy` workflow on every push to `main` | `Preview` workflow on every PR push |

**Pushing to `main`** runs typecheck and tests, then deploys staging and smoke-tests it (API and phone check). Only if that passes does it deploy production and smoke-test that too.

**Every pull request** gets:
- the typecheck, tests and a staging build
- a preview URL
- proof captured from the preview: phone screenshots of the results, rates and directions, a desktop screenshot, a walkthrough GIF and video, and a table of checks (API, overflow at 320 and 390 px, browser errors, directions links)

The preview link, images and check table are written into the top of the PR description. Images are kept on the `pr-proof` branch (latest per PR only) and videos in the workflow artifacts for 14 days. A separate check fails the PR if *What changed*, *Why*, *Risk assessment* (with a level) or *How it was tested* is left empty; the template is `.github/pull_request_template.md`.

How the preview workflow stays safe:
- **No PR code with the Cloudflare token.** The job that holds the token never checks out or runs code from the PR. It takes only the built JavaScript and static files and deploys them with a Wrangler config it writes itself, pinned to the staging Worker and staging database.
- **No secrets for the capture job.** The capture job runs the PR's own code (so a UI change is checked by its own capture script) with no secrets and read-only access.
- **No code in the publish job.** The publish job can write to the repo but runs no repository code; it only copies known image files and the summary.
- **No secrets for forks.** PRs from forks get no secrets and no preview.
- **Deploys only from `main`.** The `staging` and `production` GitHub environments accept only `main`.

Previews run the PR's code on the staging Worker, so they can read staging's secrets (for example the OneMap login). That's acceptable while you're the only one pushing branches. If others start opening PRs, give staging its own OneMap account.

### One-time setup: GitHub secrets for Cloudflare

1. **Create the API token.** In the Cloudflare dashboard, open **My Profile → API Tokens → Create Token → Custom token** and name it "ParkWhere GitHub Actions". Give it these permissions:
   - Account → **Workers Scripts** → Edit
   - Account → **D1** → Read
   - Account → **Account Settings** → Read
   - Zone → **Workers Routes** → Edit
   - Zone → **Zone** → Read

   Under **Account Resources**, include only *Najibninaba@gmail.com's Account*. Under **Zone Resources**, include only the specific zone **bijan.app**. Optionally set a TTL. Create the token and copy it; Cloudflare shows it once.
2. **Add the secrets to the repo** from a terminal, not in chat. Each command prompts for the value without echoing it:

   ```sh
   gh secret set CLOUDFLARE_API_TOKEN --repo najibninaba/parkwhere
   gh secret set CLOUDFLARE_ACCOUNT_ID --repo najibninaba/parkwhere   # b436466d17f13090305cad85ae432f57
   ```

   You can do the same in GitHub under **Settings → Secrets and variables → Actions → New repository secret**.
3. **Give staging the app secrets** (optional), so previews and staging use OneMap search and LTA carparks too:

   ```sh
   pnpm exec wrangler versions secret put ONEMAP_EMAIL --env staging
   pnpm exec wrangler versions secret put ONEMAP_PASSWORD --env staging
   pnpm exec wrangler versions secret put LTA_DATAMALL_ACCOUNT_KEY --env staging
   ```

   Use `versions secret put` for staging. PR previews upload versions of the staging Worker without deploying them, so its latest version is usually not the deployed one, and plain `secret put` refuses to run. The secret is stored on a new, undeployed version. Later uploads (PR previews, and the next staging deploy from `main`) inherit it.

The token can only read D1, so CI never applies migrations. When a PR adds one, apply it before merging:
- staging: `pnpm exec wrangler d1 migrations apply parkwhere-staging --remote --env staging`
- production: `pnpm exec wrangler d1 migrations apply parkwhere-production --remote`

**Manual deploys:** `pnpm run deploy:staging` and `pnpm run deploy` (`pnpm deploy` is a built-in pnpm command, so use `run`).

**Rollback:** `pnpm exec wrangler rollback` (add `--env staging` for staging), or revert the PR.

**Worker secrets in production:** `ONEMAP_EMAIL` and `ONEMAP_PASSWORD` (OneMap search), `LTA_DATAMALL_ACCOUNT_KEY` (mall and URA carparks; without it they're left out), and optionally `DATA_GOV_SG_API_KEY`. Set them with `pnpm exec wrangler secret put <NAME>`. For local runs, put them in `.dev.vars`, which git ignores.

## Not done yet

- Place search needs the OneMap account above. Until then the app searches HDB carpark addresses and says so.
- Mall and URA carparks have counts but no prices. LTA's only rates dataset ("Carpark Rates" on data.gov.sg) is free text from 2018, and URA's own rates API needs a separate URA access key.
- LTA's feed only covers carparks that report to it. Other private carparks aren't covered.
- There are no estimates for coupon carparks, stays during peak-hour windows, or Central Area weekday public holidays.
- Loading/unloading bays are left out of results.
- Season-parking-only carparks (`short_term_parking = NO`) are left out.
- Distances are straight-line from the destination, not walking routes.
- Directions go to the registry point, not a verified entrance.
- The public holiday list needs a manual update when MOM publishes 2028.
- There's no dark mode yet.

## Sources and licences

Contains information from Carpark Availability and HDB Carpark Information, accessed from data.gov.sg, and from Car Park Availability, accessed from LTA DataMall, all under the [Singapore Open Data Licence v1.0](https://data.gov.sg/open-data-licence). LTA's API terms allow commercial use with attribution and server-held keys. LTA's general website terms also ban caching; we take the API terms as governing API use, keep the key on the server and keep only the last minute's snapshot. Maps are © OneMap contributors and the Singapore Land Authority. Charges follow HDB's published short-term parking pages. ParkWhere is not affiliated with HDB, SLA or GovTech.
