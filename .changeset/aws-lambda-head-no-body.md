---
"@nifrajs/aws-lambda": patch
---

A `HEAD` request now gets a body-less answer from both `handle()` and `streamHandle()`: the GET route's status and headers, an empty `body`, and no streamed chunks. Before, the adapter returned the full GET body for `HEAD`, and a streaming route was read to its end. A streaming body is now cancelled instead, so its producer learns nobody is reading, as on the Node, Bun and Deno adapters.
