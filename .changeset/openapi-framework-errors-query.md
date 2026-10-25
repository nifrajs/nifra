---
"@nifrajs/schema": minor
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

`toOpenAPI`, `buildOpenApiDocument` and the `openapi()` plugin list every error the framework answers
itself, as the shared `NifraError` component: `500` on every route, `404` on a path whose parameter
has a pattern a value can miss, and `429` with a `Retry-After` header where `rateLimit()` covers the
route, beside the `400`/`413`/`415`/`422` they already listed. A route's own `errors` schema for a
status still wins, which is where an app whose `onError` or `notFound()` writes another body declares
it.

A query list is declared as `style: form, explode: true`, the repeated keys the parser reads
(`?tag=a,b` is the one value `"a,b"`). A boolean read by `t.query`, `t.headers` or `t.cookies` lists
the text it accepts (`true`/`1`, `false`/`0`/`-0`, either case) as `x-nifra-boolean-literals`; a schema
that does not coerce lists none. `reflectSchema` and the project evidence snapshot record such a schema
as `coerces: true`, so a document built from evidence matches one built from the app.

`nifra check` adds NF-C054 (info): in a project that builds its document from the running routes
(`openapi()`, `buildOpenApiDocument`, `toOpenAPI`), a route registered without a `response` schema,
which the document can only describe as a `200` with no body type. Declare the schema, build the
document with `nifra openapi`, or mark the route with `// nifra-expect NF-C054: <reason>`.
