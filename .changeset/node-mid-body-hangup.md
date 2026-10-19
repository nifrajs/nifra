---
"@nifrajs/node": patch
---

A client that leaves partway through a declared request body is let go at once on Node. Node reports the early end of the stream as a parse error, and the adapter's `clientError` handling waited for the in-flight response before closing the connection - but that response was waiting for the rest of the body, so the request stayed in flight until `stop()` force-closed it at the drain deadline, and every graceful shutdown sat out the full drain. The connection now closes as soon as the request it cut off has no finished response, so the body read rejects (the JSON body lane answers its flat 400) and the request ends. A body read that starts after the connection is already gone also rejects instead of waiting forever.
