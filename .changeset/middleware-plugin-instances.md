---
"@nifrajs/middleware": patch
---

A second `healthcheck()`, `cacheControl()` or `openapi()` with its own configuration now applies alongside the first instead of being skipped as a duplicate. Applying the same instance twice still wires it once.
