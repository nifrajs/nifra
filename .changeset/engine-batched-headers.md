---
"@nifrajs/node-engine": patch
---

Send responses that set their own headers or cookies through the experimental Node engine's batched writer, which lowers their per-request cost. Rebuild the native addon together with this package: `serve` now refuses an older one.
