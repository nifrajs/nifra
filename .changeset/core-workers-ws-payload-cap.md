---
"@nifrajs/core": patch
---

`toFetchHandler` on Workers enforces `wsMaxPayloadBytes` on inbound WebSocket frames, as the Bun, Node, Deno and hub lanes do: a larger frame closes the socket with 1009.
