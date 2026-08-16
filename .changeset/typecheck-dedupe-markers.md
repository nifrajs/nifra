---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/web": patch
---

Frontend framework deduplication is now applied consistently across the Bun build, the Vite build, and the Vite dev server, so React, Preact, and Svelte each load a single copy in every client bundling path.
