---
"@nifrajs/core": minor
---

`QUERY` is a standard method. A route registered with `method("QUERY", path, schema, handler)` from `@nifrajs/core/methods` joins the typed registry, validates a `body` schema, and is listed in `METHODS`; `all()` now covers it too. It has no builder of its own. On Bun it is served by the portable router, since Bun's route table has no slot for it, while other routes on the same path stay on the table. `securityBaseline()` holds a QUERY route to its read rules; its body is bounded like any other.
