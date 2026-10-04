---
"@nifrajs/core": patch
---

The route manifest, project evidence snapshot, capability lockfile, and single-copy report sort by code unit instead of `localeCompare`, so their bytes and the manifest's `contentHash` no longer depend on the runtime's locale or ICU data. A manifest whose routes include paths that the two orders rank differently (mixed case, `-` beside `_`, non-ASCII) gets a new route order and `contentHash` once when it is rebuilt.
