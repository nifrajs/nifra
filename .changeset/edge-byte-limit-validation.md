---
"@nifrajs/edge": patch
"@nifrajs/core": patch
---

`server({ maxBodyBytes })` from `@nifrajs/edge` refuses a `maxBodyBytes` that is not a non-negative safe integer at construction, with the same `RangeError` the full `@nifrajs/core` server throws. A `NaN` (an invalid numeric environment value, for example) compared false against every body length, so the edge server accepted bodies of any size.
