---
"@nifrajs/aws-lambda": patch
---

`streamHandle` stops streaming when the client goes away during backpressure. After a `write()` that returned `false` it waited only for `drain`, so a response stream that closed or errored instead left the invocation waiting, the app's body still producing and the stream never ended. It now also finishes on `close` or `error`, or at once when the stream is already destroyed; it then cancels the response body, ends the stream, settles background work, and removes its listeners. `ResponseStream` declares the optional `off` and `destroyed` members it reads.
