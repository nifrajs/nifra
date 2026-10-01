---
"@nifrajs/middleware": patch
---

`csrf()` rejects a streamed form body as soon as it passes the token field limit, and cancels the request body without waiting for the stream's own cleanup. A form within the limit still reaches the handler with its body intact.
