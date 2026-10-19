---
"@nifrajs/core": patch
---

On Bun, a WebSocket `close` handler gets `1009` "message too large" for a message over the listener's frame limit, as it does for every other payload cap and on every other runtime; it got `1006` "Received too big message". Bun drops that connection without a close frame, so the client still sees `1006`, and the `wsMaxPayloadBytes` documentation says so.
