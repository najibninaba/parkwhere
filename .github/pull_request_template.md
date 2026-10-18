<!-- The Preview and proof section is added above this line automatically once the preview deploys. -->

## What changed

<!-- What a reviewer will see: behaviour, screens, data, config. Bullets are fine. -->

## Why

<!-- The problem this solves or the request it answers. -->

## Risk assessment

<!-- Rate it, then say what could go wrong for drivers and how we'd undo it. -->

- **Level:** Low / Medium / High
- **Data honesty:** Could availability, freshness or prices be shown wrongly (unknown as 0, stale as current, an invented total)?
- **What breaks if this is wrong:**
- **Infrastructure:** D1 migration, new secret, binding or DNS change? (Migrations aren't applied by CI.)
- **Rollback:** Revert the PR, or `pnpm exec wrangler rollback` for production / `--env staging` for staging.

## How it was tested

<!-- Commands run (pnpm check, pnpm check:mobile), manual checks, and anything not tested. -->

## Second opinions

<!-- Astra / Fable review findings and what was done about them, or why none were needed. -->
