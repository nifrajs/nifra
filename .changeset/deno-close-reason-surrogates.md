---
"@nifrajs/deno": patch
---

`ws.close()` on Deno counts a lone surrogate in the reason as the three bytes of U+FFFD it is sent as, as Bun and Node do. A reason over 123 bytes that way now throws the same `RangeError` before the socket is touched; it used to reach Deno's `WebSocket.close`, which threw a `SyntaxError`.
