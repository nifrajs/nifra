---
"@nifrajs/core": minor
---

feat(core): app-wide default `onValidationError` + `kind` argument

`server({ onValidationError })` now sets an app-wide fallback that fires when a route **without its own**
`onValidationError` fails body/query validation — one place to define your error envelope instead of repeating
it per route (like tRPC's `errorFormatter` / Fastify's `setErrorHandler`), while a route's own hook still
takes precedence. A route can fall through to the plain `422` by returning `undefined`.

The hook (route-level and app-level) now also receives a third argument, `kind: "body" | "query"`, telling it
which input failed — backward-compatible (existing 2-arg hooks are unaffected). The healed-value re-validation
contract is unchanged: an app-level default that returns a repaired value is re-validated against the route's
schema before the handler runs.
