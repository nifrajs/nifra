---
"@nifrajs/schema": minor
---

feat(schema): `t.deferred` and `t.declassified`

`t.deferred(schema)` describes a loader value marked with `defer()`: `@nifrajs/web` projects and
validates what it resolves to by `schema` before it streams. `t.declassified(reason, schema)` allows a
field with a sensitive name (`token`, `password`, `apiKey`, ...) in an output schema and records why
it may reach the browser. `DeferredValue<T>` is the type of a deferred value.
