---
"@nifrajs/core": minor
"@nifrajs/schema": minor
"@nifrajs/cli": minor
---

A `t.object` in a route's `query`, `headers` or `cookies` slot converts the text it receives to the
types it declares, as `t.query`, `t.headers` and `t.cookies` do: `?archived=true` is `true` and
`?page=2` is `2`, where both were a 422. It stays closed, a `body` slot still converts nothing, and a
schema compiled with `compileSchema` reads the same text as its source. The OpenAPI document lists
the boolean literals such a field accepts. Core takes the converting form a schema offers under
`Symbol.for("nifra.schema.textSlot")` on its `validate`, so it ships no conversion code.

`nifra check` adds NF-C055 (warn): zod's `z.coerce.boolean()` in a route's `query`, `headers` or
`cookies` schema. It is `Boolean(value)`, so `"false"` and `"0"` read as `true`; `z.stringbool()`
reads them as false and refuses text it does not know.
