---
"@nifrajs/core": patch
"@nifrajs/edge": patch
---

`@nifrajs/edge` now refuses a cross-site HTML form post to a `POST`, `PUT`, `PATCH` or `DELETE` route that has no body schema, with `403 forbidden_origin` before the handler runs, as it already did for a body-schema route and as `@nifrajs/core`'s `server()` does. `formOrigins` admits the same origins. `@nifrajs/core/edge-kit` exports `crossSiteFormRefused` for it.
