# Contributing to ParkWhere

Thanks for helping. ParkWhere is a small civic tool that one person maintains, so small, focused changes are easiest to review.

## Before you start

- For a bug or a wrong carpark detail, open an issue first. Use the "Carpark data looks wrong" template for data problems.
- For a new feature, open an issue to discuss it before you write code. Some features are out of scope on purpose: accounts, payments, bookings, predictions, entrance photos and walking routes.
- Read [AGENTS.md](AGENTS.md) for the layout and the data rules, and [DESIGN.md](DESIGN.md) for the visual system. The data rules are the most important part of this project: unknown is never zero, old counts are never shown as current, and prices are never invented.

## Set up

You need Node.js 24 or later, pnpm 10 and Google Chrome (for the phone checks).

```sh
pnpm install
pnpm exec wrangler d1 migrations apply parkwhere-production --local
pnpm dev
```

The app runs without any keys. Place search falls back to HDB carpark addresses, and mall and URA carparks are left out. To try those features locally, put your own `ONEMAP_EMAIL`, `ONEMAP_PASSWORD` and `LTA_DATAMALL_ACCOUNT_KEY` in `.dev.vars`, which git ignores. Never commit keys.

## Make a change

1. Branch from `main`.
2. Add or update tests next to the code you change. Logic belongs in `shared/` with unit tests, I/O in `worker/`, and UI in `src/`.
3. Run `pnpm check` (typecheck, tests and build). For UI changes, also run `pnpm check:mobile` while `pnpm dev` is running.
4. Open a pull request using the template. Fill in What changed, Why, Risk assessment (with a level) and How it was tested. A check fails the PR if any of these are empty.

Pull requests from this repository get a preview deployment and captured proof (screenshots, a walkthrough and checks) in their description. Pull requests from forks don't get previews, because they don't receive deploy secrets. A maintainer can check them out locally instead.

## Writing copy

Text in the app should be plain and specific. Use short sentences and the words drivers use. Say what a number is and when it was reported. Avoid hype, em dashes and "not X, but Y" phrasing. AGENTS.md lists the terms the app uses.

## Licence

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
