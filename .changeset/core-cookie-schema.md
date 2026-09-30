---
"@nifrajs/core": minor
"@nifrajs/schema": minor
---

feat(core): a route schema takes `cookies`, validated before the handler like `headers` and `query`.

```ts
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

export const app = server().get(
  "/dashboard",
  { cookies: t.cookies({ session: t.string(), page: t.optional(t.integer()) }) },
  (c) => ({ session: c.cookies.session, page: c.cookies.page ?? 1 }),
)
```

The schema checks the cookies parsed from the `Cookie` header (URL-decoded values, the first of a
repeated name) and its output types `c.cookies`. A request that fails it is a `422`, and
`onValidationError` receives the kind `"cookies"`; code that lists that parameter's kinds by hand
needs the new member. `defineContract` operations take `cookies` too. Route reflection, contract
snapshots and diffs, project evidence and the OpenAPI document carry the schema, and OpenAPI lists
each declared field as an `in: cookie` parameter.

`t.cookies` builds the schema for this slot. Like `t.query` it coerces declared number and boolean
fields from text and lets undeclared cookies through, since a browser sends every cookie the site
has set.
