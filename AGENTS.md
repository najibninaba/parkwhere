# ParkWhere: agent notes

ParkWhere is a Singapore parking finder at https://parkwhere.bijan.app. It covers HDB carparks, the mall and URA carparks that report counts to LTA, and public carparks mapped on OpenStreetMap. A single Cloudflare Worker serves both the PWA and a small JSON API. One person maintains it, so keep it small, honest and low-maintenance.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Runs Vite and the Worker together in workerd via `@cloudflare/vite-plugin`, using a local D1 |
| `pnpm check` | Runs typecheck, tests and the production build. Run this before calling a change done. |
| `pnpm test` | Vitest: `shared/` logic, `worker/` routes with a node:sqlite D1 stand-in, `src/` UI in jsdom |
| `pnpm check:mobile [url]` | Emulates 320, 390 and 412 px phones with the installed Chrome. Fails on horizontal overflow or tap targets under 40 px. Writes `screenshots/`. Needs `pnpm dev` running. |
| `pnpm proof <url> [dir]` | Captures screenshots, a walkthrough video and checks from a deployed build. CI runs this on every PR preview. |
| `pnpm run deploy:staging` / `pnpm run deploy` | Manual deploys. Normally the `Deploy` workflow does this: main goes to staging, then to production once staging passes. |
| `pnpm media [url]` | Regenerates the README screenshots, walkthrough and diagram images in `docs/media`. Needs a running app. |
| `pnpm registry` | Refreshes `worker/registry.json` from data.gov.sg. Review the diff, then commit. |
| `pnpm osm [--refresh]` | Refreshes `worker/osm-carparks.json` from OpenStreetMap (Geofabrik extract, cached in `.cache/osm/`). Needs `osmium` (`brew install osmium-tool`). Review the diff, then commit. |
| `wrangler d1 migrations apply parkwhere-production --local` | Run once before the first `pnpm dev` |

## Layout

- `shared/` holds pure domain logic with no I/O. It is imported by both the Worker and the app, and every rule here has a test next to it.
  - `availability.ts`: normalises the feed, rates record freshness and builds the feed status
  - `lta.ts`: normalises LTA DataMall (LTA and URA car rows only) and its honest availability, with no time and no total
  - `osm.ts`: picks public carparks from OpenStreetMap features (build time) and turns them into carparks with no count (run time)
  - `levels.ts`: dot and count colour levels; the overview only colours current, dated HDB counts
  - `nearby.ts`: distance, radius search and the fallback when nothing is in range
  - `tariff.ts`: HDB charge rules and cost estimates
  - `holidays.ts`, `sgt.ts`, `svy21.ts`: public holidays, Singapore time and coordinate conversion
  - `feed-schema.ts`: Effect Schema for the upstream feed. Only the Worker imports it, which keeps Effect out of the browser bundle.
- `worker/` is the I/O edge.
  - `upstream.ts`: Effect fetch with retry and typed errors
  - `feed.ts`: last-good snapshots in D1 and the refresh policy, one store per source (HDB, LTA)
  - `lta.ts`: paged Effect fetch of LTA DataMall
  - `search.ts`: OneMap search, with HDB registry search as the fallback
  - `index.ts`: routes
- `src/` is the React UI. `CarparkMap` is lazy-loaded and uses Leaflet with OneMap tiles.
- `fixtures/` holds trimmed real upstream responses. Prefer real samples over invented data in tests.
- `scripts/` holds Node 26 TypeScript scripts, which run directly with no build step.

## Data rules (do not regress)

1. Unknown availability is never zero. `available: null` means unknown, and the UI shows "?" or "No live count", never 0.
2. Three times are kept separate: `fetchedAt` (when we received the response), `feedTimestamp` (the feed's own time) and each record's `recordedAt`. A fresh response can carry year-old records.
3. The feed splits some carparks into several records by lot type. Key data by (carpark id, lot type), let the newest record win, and never add records together. Car counts use lot type `C` only.
4. Refresh failures and last-good data are always labelled (`feed.state`, `feed.refreshError`).
5. A count describes the whole carpark when it last reported. It doesn't reserve a lot, describe a single bay or predict the future.
6. Registry coordinates are not entrances. Navigation goes to Google Maps, Apple Maps or Waze with that caveat. Don't build turn-by-turn guidance.
7. Cost estimates come only from rules HDB publishes (see the header of `shared/tariff.ts`). When a rule is missing or ambiguous (coupon carparks, peak windows, Central Area rates on public holidays, unpublished holiday years), return `unavailable` with the published rate.
8. Don't add accounts, payments, bookings, predictions, entrance photos or manual walking routes.
9. LTA DataMall counts have no time and no total. Never colour them as current, never write "now" about them, and never price them. HDB rows from LTA are dropped in favour of data.gov.sg's.
10. OpenStreetMap carparks have no count and no price. Keep one only when it's explicitly tagged `access=yes`, `customers` or `permissive`: a missing tag never means public. Heavy-vehicle, loading, drop-off, season-only and HDB-run parking is left out. One within 80 m of an HDB, LTA or URA carpark, with the same name as an LTA or URA carpark within 300 m, or unnamed within 250 m of one, is the same carpark and is left out. A mapped entrance is still unverified, so the card says so.

## External services

- data.gov.sg HDB availability (v1 real-time) needs no key. The optional `DATA_GOV_SG_API_KEY` secret raises rate limits. The refresh claim keeps upstream calls to about one a minute.
- OneMap search needs a token according to its docs. It turns on only when the `ONEMAP_EMAIL` and `ONEMAP_PASSWORD` secrets are set; the token is cached in D1 for 3 days. OneMap tiles need no token but must show the OneMap logo and attribution.
- Attribution under the Singapore Open Data Licence, and the OpenStreetMap credit, are in `src/components/Footer.tsx`.
- OpenStreetMap data comes from Geofabrik's extract at build time only; the Worker never calls OpenStreetMap. `worker/osm-carparks.json` is under the Open Database Licence (ODbL 1.0), not MIT.
- LTA DataMall (`LTA_DATAMALL_ACCOUNT_KEY`) adds mall and URA carparks. Without the key they're left out, and nothing else changes. URA's own API (rates) isn't integrated: it needs a separate URA access key.

## Environments and pull requests

- Production is the `parkwhere` Worker at parkwhere.bijan.app. Staging is `parkwhere-staging` at parkwhere-staging.bijan.app, with its own D1. PR previews are preview aliases of the staging Worker (`pr-<n>`). See the README.
- Every PR needs a description following `.github/pull_request_template.md`: what changed, why, a risk assessment with a level and how it was tested. Record any independent reviews under "Second opinions". CI fills in the preview and proof section.
- CI never applies D1 migrations. Apply them to staging, then production, before merging a PR that needs them.

## Conventions

- Keep pinned dependency versions. Effect 4 and TypeScript 7 are in use; check the API against `node_modules/effect/dist/*.d.ts` rather than memory.
- Don't commit secrets. Local secrets go in `.dev.vars`, which git ignores.
- Ask the owner before deploying, creating Cloudflare resources or credentials, or changing DNS or routes.
- Follow [DESIGN.md](DESIGN.md) for anything visual. Regenerate README images with `pnpm media` after visible changes.

## Copy

The app's text is plain, specific and calm. It should read like a notice, not a pitch.

- Terms: "car lots available" (not "spaces" or "free lots", which could mean free parking). A carpark **reports** a count; ParkWhere **checks** the feed. Say "count", not "data", in the UI.
- Every claim about a count says when it's from. Never write "now" about a count older than 15 minutes or one with no time.
- Short sentences, everyday words, Singapore English. No em dashes, no hype or self-praise ("honest", "seamless"), and no "not X, but Y" framing.
- Errors say what failed and what still works ("HDB counts are unavailable. Carparks and prices are still shown.").
