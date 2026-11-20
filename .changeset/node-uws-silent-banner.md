---
"@nifrajs/node-uws": patch
---

Replies no longer carry the `uWebSockets: 20` header. uWS's banner is switched off for the process when the adapter loads it.
