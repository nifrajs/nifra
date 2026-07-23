---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

The full Vite/Rollup production build: `buildClientVite`, `buildServerVite`, `buildTargetVite`, and `nifra build --vite`.

Production stays Bun by default - faster and Bun-native, the profile nifra is tuned for. This completes
the escape hatch for the one case that default cannot serve: an app whose client needs a Vite-only
transform with no Bun equivalent. It now has a real, full production path, not just the leak-guard plugin.

The design point is that this is NOT a second orchestrator. `buildTarget`'s deploy assembly - per-target
server-entry codegen, `_worker.js` / `server.js` placement, `_routes.json`, prerender, size report - is
bundler-agnostic and now lives behind `buildTargetWith(target, options, bundler)`, which takes a `Bundler`
strategy (its two bundling steps). `buildTarget` passes the Bun strategy; `buildTargetVite` passes the
Vite one. So the deploy-dir shape is produced in exactly one place and cannot drift between pipelines -
`buildTargetVite` emits the identical directory for every target.

`buildClientVite` reconstructs the same `BuildManifest` the Bun `buildClient` does - content-hashed entry,
per-route chunk lists, aggregate + per-route CSS, copied `public/` - from Vite's own `.vite/manifest.json`.
It wires `viteLeakGuard()`, and it keeps `node:` builtins external so the guard names the offending builtin:
left alone, rolldown-vite silently rewrites a `node:` import to a browser stub, which builds and ships and
is a no-op at runtime - a worse footgun than Bun's polyfill, now a build failure. `buildServerVite`
produces the same self-contained `ServerBuild`, tagging the bundle `NIFRA_SSR_BUNDLED` so the web-react
adapter uses the bundled, deduped react-dom rather than re-rooting to a disk copy.

`nifra build --vite` selects the pipeline; the app's Vite plugins drive both halves. Verified end to end by
building the React example for the `node` target, running the server, and confirming SSR plus live
hydration in a real browser, alongside `cf-pages` (`_worker.js` + `_routes.json`) and `static` (prerender,
no server) deploy shapes.

No change to the default Bun build: `buildTarget` now delegates to `buildTargetWith` with the Bun strategy,
and its behaviour and output are identical.
