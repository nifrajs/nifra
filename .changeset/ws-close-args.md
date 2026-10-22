---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/deno": patch
---

`ws.close(code, reason)` with a close RFC 6455 forbids - a code outside 1000-1003, 1007-1014 and
3000-4999, a reason over 123 UTF-8 bytes, or a reason without a code - throws a `RangeError` on every
runtime, and the socket stays open. Bun and Deno sent such a close on the wire; on Node, `ws` threw
after marking the socket closing, so its later sends were dropped and the client's close was never
answered; Workers threw their own error.
