---
"@nifrajs/web-react": patch
---

SSR `react-dom/server` resolution now also detects a bundled server that was built without `nifra build` (a hand-rolled `bun build --target bun` carries no bundle marker): inside any bundle the adapter uses the bundle's own inlined, deduped react-dom instead of re-importing a second copy from disk. That second copy could crash hook-using components (two React cores) or, hook-free, silently render with development React when the runtime `NODE_ENV` was unset - an SSR slowdown that looked like a runtime regression. The SSR benchmark's Bun row builds with the same bundle marker `nifra build` stamps, so it measures production React.
