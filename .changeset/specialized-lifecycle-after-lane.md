---
"@nifrajs/core": patch
---

Optimize routes with exactly one `derive`, `beforeHandle`, and `afterHandle` hook using a
registration-specialized lifecycle lane while preserving existing async, short-circuit, and error
semantics.
