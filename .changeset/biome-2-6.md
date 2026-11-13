---
"@nifrajs/e2e": patch
"@nifrajs/web": patch
---

No behavior change for consumers. Tooling moves to Biome 2.6; `@nifrajs/web` now throws a named error, not a bare TypeError, if an error render is asked for an `_error` module its manifest does not list.
