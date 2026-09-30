---
"@nifrajs/core": minor
"@nifrajs/edge": minor
"@nifrajs/schema": minor
"@nifrajs/cli": minor
---

feat(core): a path can end in optional params, written `:name?`. The route serves the path with the
param and without it:

```ts
app
  // GET /users and GET /users/42
  .get("/users/:id?", (c) => (c.params.id === undefined ? { all: true } : { id: c.params.id }))
  // GET /archive, GET /archive/2026 and GET /archive/2026/09
  .get("/archive/:year?/:month?", (c) => ({ year: c.params.year, month: c.params.month }))
```

- Optional params are whole segments at the end of the path. Several in a row are filled left to
  right: a later one is present only when every earlier one is. A `?` anywhere else (`/a/:id?/b`,
  `/v-:id?`) is literal text, as before.
- An optional param is typed `string | undefined`. When the path omits it, it is absent from
  `c.params`, not an empty string. A `params` schema that requires it answers `422` on the shorter
  path.
- The route is registered once per path it serves, with the same handler, schema and hooks.
  `app.routes()`, `group()`, `merge()`, `implement()`, `ws()` and the typed registry all see those
  paths, so `GET /users` registered next to `GET /users/:id?` throws `DUPLICATE_ROUTE`. A route that
  is rejected leaves none of its HTTP paths registered.
- The typed client calls each path: `api.users.get()` and `api.users({ id }).get()`.
- `defineContract` accepts the same paths; two operations that serve the same method and path are
  refused.
- `expandOptionalParams(pattern)` from `@nifrajs/core/pattern` returns the paths a pattern serves,
  shortest first. `Router.add` from `@nifrajs/core/router` registers exactly the pattern it is given;
  a caller that wants the optional form adds each expanded pattern.
- `routePatternOverlap` compares every path each side serves, under one work budget for the call.

feat(edge): the compact server accepts the same optional params.

feat(schema): `toOpenAPI` emits one operation per path an optional-param route serves. A shorter
path declares only the parameters it has. For a contract, the operation name is the `operationId` of
the full path, and the shorter paths carry none.

feat(cli): `nifra check` reports `NF-C026` (warning) for a param followed by `?`, `*`, `+`, `{`, `(`
or `<` that the path grammar reads as literal text, and names a `?` route that no request can reach.
`// nifra-expect param-modifier` above the registration marks a deliberate literal. Overlap and
duplicate checks read an optional-param route as every path it serves.
