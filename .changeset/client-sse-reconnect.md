---
"@nifrajs/client": patch
---

`.subscribe()` reconnects more carefully. A server's `retry:` hint times the reconnect after a stream it served, but while reconnects keep failing the client still backs off, with the hint as the minimum wait. `retry:` is read as the SSE grammar defines it (ASCII digits only), CR and CRLF line endings are understood alongside LF, an event being assembled is bounded by `maxDecodedBytes`, an `id:` containing NUL is ignored, and an id beyond ASCII is sent back in `Last-Event-ID` as its UTF-8 bytes. Waiting between reconnects no longer leaves a listener behind on the subscription's signal.

A call with `retry` configured now cancels the body of each response it discards, and stops retrying once the call is aborted or its `timeoutMs` has passed, instead of waiting out the remaining backoff.
