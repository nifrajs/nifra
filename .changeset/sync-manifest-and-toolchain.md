---
"@nifrajs/cli": minor
"@nifrajs/web": minor
---

`nifra sync-manifest`, plus two toolchain guards that turn opaque failures into actionable ones.

- **`nifra sync-manifest`.** After adding/renaming/removing a page route, the committed `server-manifest.ts` drifts and `nifra check` flags it - and clearing that used to mean a full build (server + worker + migrate bundles). `nifra sync-manifest` re-scans `routes/` and rewrites just the manifest's route table in milliseconds, preserving the baked client-asset references. It does not rebuild the client bundle, so it prints a caveat: a brand-new hydrating route component still needs a full build for its client chunk. `@nifrajs/web/build` gains the pure `resyncServerManifestSource` (+ `parseManifestStyles` / `parseManifestRouteStyles`) it is built on.
- **`nifra dev` peer preflight.** Run under `bunx @nifrajs/cli dev` (an isolated install where the project's peers do not resolve), the Vite import failed with an opaque `ERR_MODULE_NOT_FOUND`. It now checks `vite` resolves from the project first and, if not, says to run the workspace-local `bun run dev`.
- **`nifra start` build-target guard.** Pointed at a Cloudflare Pages output (a `_worker.js` bundle, no `server.js`), `nifra start` now names the mismatch and the fix (`nifra build --target bun`, or serve with `wrangler pages`) instead of a bare "no server.js".
