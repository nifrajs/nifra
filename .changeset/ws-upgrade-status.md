---
"@nifrajs/core": patch
---

A WebSocket route's `upgrade()` may return `status(...)` to refuse the handshake, as the docs show,
with the types to match: an explicit `app.ws<Data>()` now compiles with it, and an inferred one no
longer counts the refusal as part of `ws.data`.
