---
"@nifrajs/graphql": patch
---

Over HTTP, `executionTimeoutMs` now aborts the execution's signal, which resolvers read through `info.getAbortSignal()`, instead of only answering 504 while the resolvers kept running. An aborted request aborts it too. The WebSocket transport already did this.
