---
"@nifrajs/core": patch
---

A route that declares an explicit finite `schema.bodyLimit` now publishes `nifra.body-bounded` route assurance evidence (source `route-schema`), the same as a route with a `schema.body`. Before this, the per-route transport cap bounded a body more strongly than the Content-Length `bodyLimit()` middleware - it also binds a raw `c.req.body` stream, which a Content-Length gate cannot - yet published nothing, so adopting the per-route cap could lower an app's L1 assurance level. `bodyLimit: "unlimited"` still publishes nothing, and the server-wide `maxBodyBytes` default is deliberately not evidence: it applies to every route whether or not anyone chose it.
