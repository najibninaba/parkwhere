# Contributing to ParkWhere

Thanks for helping. ParkWhere is a small civic tool that one person maintains, so small, focused changes are easiest to review.

## Before you start

- For a bug or a wrong carpark detail, open an issue first. Use the "Carpark data looks wrong" template for data problems. If you'd rather not use GitHub, "Report a problem" on the carpark's card in the app works too.
- For a new feature, open an issue to discuss it before you write code. Some features are out of scope on purpose: accounts, payments, bookings, predictions, entrance photos and walking routes.
- Read [AGENTS.md](AGENTS.md) for the layout and the data rules, and [DESIGN.md](DESIGN.md) for the visual system. The data rules are the most important part of this project: unknown is never zero, old counts are never shown as current, and prices are never invented.

## Set up

You need Node.js 24 or later, pnpm 10 and Google Chrome (for the phone checks).

```sh
pnpm install
pnpm exec wrangler d1 migrations apply parkwhere-production --local
pnpm dev
```

To refresh the OpenStreetMap carparks with `pnpm osm`, you also need osmium-tool (`brew install osmium-tool` on macOS). The first run downloads a 250 MB extract into `.cache/osm/`.

The app runs without any keys. Place search falls back to HDB carpark addresses, and mall and URA carparks are left out. To try those features locally, put your own `ONEMAP_EMAIL`, `ONEMAP_PASSWORD` and `LTA_DATAMALL_ACCOUNT_KEY` in `.dev.vars`, which git ignores. Never commit keys.

## Make a change

1. Branch from `main`.
2. Add or update tests next to the code you change. Logic belongs in `shared/` with unit tests, I/O in `worker/`, and UI in `src/`.
3. Run `pnpm check` (typecheck, tests and build). For UI changes, also run `pnpm check:mobile` while `pnpm dev` is running. It also opens the feedback sheet, and answers its Send itself, so no report is stored.
4. Open a pull request using the template. Fill in What changed, Why, Risk assessment (with a level) and How it was tested. A check fails the PR if any of these are empty.

Pull requests from this repository get a preview deployment and captured proof (screenshots, a walkthrough and checks) in their description. Pull requests from forks don't get previews, because they don't receive deploy secrets. A maintainer can check them out locally instead.

## Updating dependencies

Dependencies are updated by hand; Dependabot alerts are on, but it doesn't open pull requests. Every version in `package.json` is pinned exactly, so an update is always a deliberate change with its own pull request.

1. See what's behind and whether anything is vulnerable:

   ```sh
   pnpm outdated
   pnpm audit
   ```

   `pnpm audit` covers `devDependencies` too, which matter here because Vite, Wrangler and `vite-plugin-pwa` build and ship the app. Add `--prod` to see only what runs in production.

2. Update with exact versions, for example `pnpm add -D --save-exact vite@8.4.0` or `pnpm add --save-exact effect@4.1.0`. Without `--save-exact`, pnpm saves a `^` range. Patch and minor updates can share one pull request. Take major versions one at a time, and read the release notes first.
3. Run `pnpm check`, then `pnpm check:mobile` with `pnpm dev` running. Open a pull request, and the preview and proof show the app still works.

Things to watch:

- **Effect and TypeScript:** check changed APIs against the installed types (`node_modules/effect/dist/*.d.ts`) rather than older docs.
- **Wrangler and `@cloudflare/vite-plugin`:** update them together, since the plugin declares the Wrangler versions it supports. If you move `compatibility_date` in `wrangler.jsonc`, change the matching date in `.github/workflows/preview.yml`. CI fails until they match.
- **GitHub Actions:** third-party actions are pinned to a commit SHA, with the version in a comment. Update both, and run `actionlint` on the workflows.
- **New packages with install scripts** (native builds) need adding to `onlyBuiltDependencies` in `pnpm-workspace.yaml`, or pnpm skips their build.
- **Playwright (`playwright-core`):** after an update, run `pnpm exec playwright-core install ffmpeg` again if `pnpm proof` or `pnpm media` can't record video.

## Writing copy

Text in the app should be plain and specific. Use short sentences and the words drivers use. Say what a number is and when it was reported. Avoid hype, em dashes and "not X, but Y" phrasing. AGENTS.md lists the terms the app uses.

## Licence

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
