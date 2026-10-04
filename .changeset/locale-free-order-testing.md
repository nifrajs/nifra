---
"@nifrajs/testing": patch
---

An agent eval case orders its rubric verdicts by code unit, so the case digest is the same on every machine and in every locale. A case whose rubric ids sort differently around `.`, `_`, `:` or `-` can digest differently from an earlier release.
