---
"@nifrajs/cli": minor
"@nifrajs/web": patch
---

`nifra dev --bun` now supports server functions and `*.server` modules. Bun's dev-server bundler accepts plugins only through bunfig's `[serve.static]` channel, so the CLI generates a config under `.nifra/dev-bun/` carrying the same production boundary plugins (server-fn RPC stubs, server-only emptying), merges the app's own bunfig `[serve.static] plugins` and `preload` entries, and re-launches itself once with `--config=` pointing at it - identical stubs across dev and build, and the old fail-closed refusal for those modules is gone. CSS Modules remain gated under `--bun`.

Also fixed in `@nifrajs/web`: `serverFn<Input, Output>(...)` with explicit type arguments is now recognized by the client-boundary scanner - it previously produced an exportless stub that failed the client build with a missing-export link error (a type argument containing parentheses still fails loudly with guidance, never silently). The dev loop's background leak guard now reports the underlying bundler errors instead of a bare "Bundle failed".
