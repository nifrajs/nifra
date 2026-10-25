---
"@nifrajs/core": patch
---

Skip unused response-body bookkeeping on general JSON routes without response hooks. In-process clients still enable the resident-body record, and response ownership checks remain unchanged.
