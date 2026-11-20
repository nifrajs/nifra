---
"@nifrajs/middleware": patch
---

`MemoryStore` reclaims expired windows a slice per hit instead of sweeping up to 100,000 entries inside one request.
