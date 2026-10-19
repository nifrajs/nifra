---
"@nifrajs/web": patch
---

The output guard's `toJSON` probe states the invariant behind its one property read, so the repository's type-assertion check accepts it. No behaviour change.
