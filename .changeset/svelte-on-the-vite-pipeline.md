---
"@nifrajs/web": minor
"@nifrajs/web-svelte": patch
"@nifrajs/cli": patch
---

Svelte runs on the Vite pipeline. `nifra dev` and `nifra build` now serve and build a Svelte app on either bundler, so a Svelte app is no longer the one framework pinned to a single pipeline, and pages render with routing context, typed search and layout data intact on both.

`@nifrajs/web` adds `setSsrModuleLoader` / `ssrModuleLoader`, the seam that makes it work. A dev server that owns SSR resolution publishes its module loader; a render adapter that has to load a compiled asset on the server reads it and loads through it, so that asset is compiled by the same toolchain as the app's routes and renders through the same copy of the framework runtime. Adapters that ship no compiled assets are unaffected.

`conditions` on the Bun dev pipeline reaches SSR, and says so when it cannot reach the client bundle Bun's dev server serves - a one-line startup notice instead of a package that quietly resolves to one file in dev and another in `nifra build`.

CSS Modules class names are now identical on both pipelines. The same class hashes to the same scoped name under `nifra dev`, `nifra dev --bun` and `nifra build`, so a selector written against a generated name behaves the same everywhere.

The dev-and-HMR guide gains a Gotchas section covering the config/adapter file split, plugin slots, resolve conditions, non-route SSR freshness, and the adapter loader.
