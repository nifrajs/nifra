---
"@nifrajs/core": patch
---

On Bun and Deno, `c.json()` keeps the JSON text it wrote when the app has a response body hook, as `c.text()` already does. A body hook such as `compression()` now receives that string instead of reading the reply back as a stream, so a gzipped `c.json()` reply goes out with a `Content-Length` rather than chunked. In Docker on four pinned CPUs a gzipped 8 KB `c.json()` route served about 9% more requests on Bun. An app with no body hook builds its `c.json()` reply as before.
