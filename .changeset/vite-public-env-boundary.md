---
"@nifrajs/web": minor
---

The Vite pipelines honour Nifra's public-env boundary, keep `.server` out of the browser on Vite 5,
and serve a valid ESM replacement in dev.

**Breaking if you relied on `VITE_*` reaching the browser.** Vite exposes any variable matching its own
`envPrefix` to client code, and Nifra never overrode it - so an app with one documented boundary
(`publicEnvPrefix`, default `PUBLIC_`) silently had a second one it had not configured. The dev server
and the production build now bind Vite's prefix to Nifra's, including the "expose nothing" setting.
Move anything the browser genuinely needs to your public prefix.

Two more holes in the same convention:

- Vite 5 has no `applyToEnvironment`, so the `.server` and `.fn` transforms ran for the SSR graph too
  and stubbed the modules the server itself needs. Both now decline when the transform is told it is
  running for SSR.
- The `.server` replacement was CommonJS, which is right for the Bun bundler and invalid in Vite dev's
  native ESM graph. Dev now gets inert ESM bindings derived from the module's exported names, with the
  implementation and its imports discarded. A shape the generator does not model declares no binding,
  so the import fails to link - server code is never served as the fallback.
