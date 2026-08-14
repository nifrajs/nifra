---
"@nifrajs/web": patch
---

`nifra sync-manifest` now preserves a lazy manifest's shape instead of silently rewriting it as eager.
The re-sync detected the lazy (`() => import(...)` per route) vs eager (`import * as`) form by looking
for `const loaders =` in the source, but the generated declaration is `const loaders: Record<...> = {` -
the type annotation sits between the name and the `=`, so the check never matched and every lazy
manifest came back eager, collapsing per-route code splitting into a single boot-time bundle. Detection
now anchors on the `const loaders` declaration itself, so a route-table refresh keeps the app's chunking
exactly as committed.
