---
"@nifrajs/core": patch
"@nifrajs/node": patch
---

No behavior change: a resolved request path encodes `^` with one unconditional replace, which costs fewer bytes in every server bundle.
