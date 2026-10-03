---
"@nifrajs/middleware": patch
---

`etag()` passes an event stream (`text/event-stream`) through untouched, and likewise a raw-body response marked `cache-control: no-store` or `no-transform`, instead of reading the whole body to hash it before any of it is sent. `compression()` no longer treats `text/event-stream` as compressible, so each event reaches the client as it is produced rather than waiting for the gzip window to fill.
