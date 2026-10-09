---
"@nifrajs/core": major
"@nifrajs/node": major
---

A `Response` a handler or hook returns or throws gets the request's `c.set.headers` it does not already carry, as well as its queued cookies, on every lane. A guard's `cache-control: no-store` now reaches a handler-built `Response`. The `Response`'s own headers win. `content-type`, `content-length`, `content-encoding`, `content-range` and `transfer-encoding` come from it alone, and `c.set.status` does not change its status. A `Response` that answers many requests is copied first, so one request's headers never reach another. A 101 upgrade and `Response.error()` take no headers. Mounted apps and `onRequest` responses are unchanged.
