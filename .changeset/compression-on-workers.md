---
"@nifrajs/middleware": patch
---

`compression()` does nothing on Cloudflare Workers, which compress responses themselves. Before, a body it gzipped there reached the client gzipped twice: the runtime encodes again any body sent with `Content-Encoding: gzip`.
