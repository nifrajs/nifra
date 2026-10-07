---
"@nifrajs/deno": patch
---

`stop({ drainMs })` counts a request as in flight until its whole response body is sent. A streamed response still running at the deadline is force-closed; before, the handler returning was enough to count as drained, and `stop()` then waited on the stream with no deadline.
