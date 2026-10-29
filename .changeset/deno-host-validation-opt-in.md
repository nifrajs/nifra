---
"@nifrajs/core": minor
---

Make strict Host validation opt-in on Deno with `server({ validateHost: true })`. Deno builds `Request.url` from Host, so leave the option enabled when requests can carry an untrusted Host header.
