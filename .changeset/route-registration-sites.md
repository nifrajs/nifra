---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

Capability provenance now also starts from the module that registered each route. While the CLI loads `nifra.assurance.ts`, a development load records the `file:line:col` of each route registration through every `group()` and `merge()`, and `reflectRouteSites()` from `@nifrajs/core/reflection` returns it. The walk adds that module to the ones the static text scan finds, so a route with a computed path, or on a server a helper builds, is covered without `provenance.routeModules`. Recording happens only with `NIFRA_ROUTE_SITES=1` outside production, and a production build carries none of it. The sites stay out of `reflectRoutes()`, so no absolute path reaches a written artifact.
