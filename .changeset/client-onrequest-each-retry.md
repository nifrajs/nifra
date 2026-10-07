---
"@nifrajs/client": patch
---

`onRequest` runs before every attempt, as documented, so a retried call sends the headers the hook returns at that moment, such as a refreshed token. Before, it ran once and each retry repeated the first attempt's headers.
