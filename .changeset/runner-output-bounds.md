---
"@nifrajs/runner": patch
---

Runner command responses are now read incrementally and canceled at the configured output limit, so an oversized or non-terminating response cannot be fully buffered before truncation.
