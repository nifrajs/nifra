---
"@nifrajs/core": patch
---

`bodyLimit: "unlimited"` now actually skips the cap on every read path, not only on direct `c.req` reads. A route that declared the exemption alongside a `schema.body` (or that called `c.boundedJson()` / `c.boundedBody()` with no explicit cap) silently fell back to the server-wide `maxBodyBytes` and answered 413 at a bound the route had explicitly opted out of. The resolved route limit is now read through `UNLIMITED_BODY_BYTES` instead of `?? maxBodyBytes`, so `undefined` keeps meaning "the route opted out" everywhere rather than flipping to "use the default" at the reader. Routes that never declared `bodyLimit` are unaffected: their limit is resolved to `maxBodyBytes` at registration, exactly as before.
