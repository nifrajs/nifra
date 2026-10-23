---
"@nifrajs/core": patch
---

The `wsMaxPayloadBytes` docs say what Bun 1.4.4 does with a message over Bun's own frame limit: it
sends the client a `1009` close, where Bun 1.4.3 dropped the connection and the client saw `1006`.
The route's `close` handler gets `1009` "message too large" on both.
