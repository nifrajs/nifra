---
"@nifrajs/node-uws": patch
---

Replies no longer carry the `uWebSockets: 20` header. uWS's banner is switched off for the thread's event loop when the adapter loads it; a worker thread switches off its own by loading the adapter.
