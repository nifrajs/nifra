---
"@nifrajs/cli": patch
---

`nifra upgrade` rewrites a nested npm override only inside the object it sits in. A nifra package's `{ ".": "5.2.0" }` was replaced across the whole `overrides` field, so another package's `{ ".": "5.2.0" }` at the same version moved to the nifra target too, a version that package may not have.
