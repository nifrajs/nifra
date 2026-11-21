---
"@nifrajs/client": patch
"@nifrajs/core": patch
"@nifrajs/middleware": patch
"@nifrajs/web": patch
---

Check response cache entries against the final response before storing them. Custom stores must preserve the new `finalized` flag, and entries written before that check was added miss on upgrade. Server component owner routes bypass the generic shared cache.

Bound WebSocket receive queues and ISR document capture and retention. Release SSE producers when their stream ends, and evict idle channel histories as subscribers disconnect.
