---
"@nifrajs/core": patch
---

On `@nifrajs/node`, a request under both a `mount()` prefix and a longer native `mountFetch()` prefix (a proxy) reaches the `mount()` first, as `app.fetch` does, so the composed app's own guards run.
