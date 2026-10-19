---
"@nifrajs/middleware": patch
---

`etag()` now answers `HEAD` like `GET`: a `HEAD` response carries the `ETag` its `GET` would, and a matching `If-None-Match` gets `304 Not Modified`.
