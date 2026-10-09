---
"@nifrajs/web": patch
---

The Bun client build maps each route, layout and the bootstrap to the chunk the build metafile names for that source file, so a page's `modulepreload` links and route chunk list always point at its own chunk. Position among the build's entry outputs is only the fallback for an entry the metafile does not name by path.
