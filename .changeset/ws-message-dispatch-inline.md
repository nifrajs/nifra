---
"@nifrajs/core": patch
---

The Bun WebSocket message path now dispatches each frame without allocating a per-frame closure, bringing echo round-trip throughput to parity with the raw runtime. Error routing is unchanged: a synchronous throw or a rejected promise from a `message` handler still reaches `error()`.
