---
"@nifrajs/core": minor
"@nifrajs/web": minor
---

Serve `public/` with byte ranges. Static files now advertise `accept-ranges`, answer a single-range request with `206` and `content-range`, return `416` for an unsatisfiable range, and publish `last-modified` with `if-modified-since` and `if-range` handling. HEAD reports the same `content-type` and length metadata GET does. `parseByteRange` moves to `@nifrajs/core/range` so the static handler and `@nifrajs/middleware`'s `rangeResponse` share one parser; the middleware export is unchanged.
