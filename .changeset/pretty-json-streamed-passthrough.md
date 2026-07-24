---
"@nifrajs/middleware": patch
---

`prettyJson` no longer hangs a client on an oversized streamed JSON response.

The middleware peeked at the body through `Response.clone()` and cancelled the clone's reader once the
byte cap was exceeded. In Bun that cancel also stalls the original body, so a JSON response with no
`content-length` and more than `maxBytes` of payload was passed through as a body that never completes.
A response that should simply have skipped pretty-printing instead never finished.

Only the cancel does this - a clone read to completion is fine - which is why every buffered response
worked and only a streamed one failed.

The body is now read directly and, when it proves too large, replayed: the bytes already pulled are
re-emitted ahead of the rest of the same reader, and cancelling that stream cancels upstream. Nothing is
buffered past the cap, and the client receives byte-for-byte what the handler produced.
