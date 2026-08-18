---
"@nifrajs/core": patch
---

Remove sideEffects entries that no longer resolve to a shipped module; the publish gate now verifies every sideEffects path against the packed tarball.
