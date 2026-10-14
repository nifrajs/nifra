---
"@nifrajs/coding-agent": patch
---

A `turn.send` stream that fails, an event over `maxResponseBytes` included, now cancels the backend turn. The RPC server closed the response with an error frame but left the producer suspended and the backend running the turn for no reader; it now stops both, as a client disconnect already did, on the plain and the resumable turn paths.
