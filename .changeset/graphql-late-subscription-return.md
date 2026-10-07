---
"@nifrajs/graphql": patch
---

A WebSocket subscription whose source arrives after `executionTimeoutMs` has its stream returned, so the source's cleanup runs. Before, the client got the timeout error but the late source stayed open.
