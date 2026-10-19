---
"@nifrajs/core": patch
---

On Bun and Deno, `onResponseBody` hooks now receive the body of a `c.text()` response and of a buffered rendered page, as they already did on Node; before, those went to `onResponseRaw`. A middleware that reads bodies, such as `compression()` or `etag()`, no longer drains them as streams there: a gzipped 33 KB text body or page serves 2.31x / 2.40x faster on Bun and the same on Deno and Node.
