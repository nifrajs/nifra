---
"@nifrajs/web": major
"create-nifra": patch
---

feat(web)!: everything a route sends to the browser passes a declared output schema

A route's backend half declares what its loader and action send to the browser:
`export const loaderOutput = t.object({ ... })` and `export const actionOutput = ...`. A boundary
loader declares `boundaryLoaders[name].output`, and a server function `serverFn({ output }, fn)`.
Before the page renders and before anything is serialized, the data is projected through its schema:
keys the schema does not declare are dropped, at every depth, even when the schema itself would accept
them, so the component and the browser see the same value. A declared field of the wrong shape fails
the request with a 500 whose message names the field's path, never its value. A loader that returns
data without an output schema fails the request; one that returns nothing, redirects or answers with
an error status needs none. A loader, action, boundary loader or server function that returns a 2xx
`Response` is refused, since its body would bypass the schema.

A deferred value is declared with `t.deferred(schema)`, and what it resolves to is projected and
validated by `schema` before it streams. A deferred value the schema does not declare as one is
refused.

An output schema that names a field such as `password`, `passwordHash`, `secret`, `token`, `apiKey`,
`privateKey` or `ssn` fails the route when it loads, unless the field is wrapped in
`t.declassified("why it may reach the browser", schema)`. `@nifrajs/web/zones` exports the name test
as `isSensitiveFieldName`.

Projection reads a nifra schema's JSON Schema, or a Standard JSON Schema such as zod's. A schema that
exposes neither keeps whatever its own `validate` returns.

The scaffolded site and ISR routes declare their loader and action output schemas.
