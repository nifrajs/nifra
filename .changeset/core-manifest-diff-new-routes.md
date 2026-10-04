---
"@nifrajs/core": patch
"@nifrajs/cli": patch
---

`diffNifraManifests` and `nifra manifest diff` diff a route that is new in the candidate manifest against an empty route. The capabilities it declares are reported as added and breaking, and a `pii` or `secret` response classification as an increase that is breaking, the same as when an existing route makes that change. A new route that declares no capability and returns public data is still only an added route.
