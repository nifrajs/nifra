---
"@nifrajs/web": minor
---

feat(web): `@nifrajs/web/forms` — typed form ↔ backend-schema binding

`formFor<typeof backend, "/route">()` binds a form's field names and reads to the route's body schema at
the type level, derived purely from `typeof backend`. `f.field("text")` (spread onto any framework's
`<input>`) and `f.read(formData, "text")` are constrained to the body's keys — a typo, an orphan field,
or a wrong route path becomes a COMPILE error (caught by `nifra check`) instead of a silent runtime
empty. Framework-agnostic, dependency-free, no schema bundled into the client (the runtime is a trivial
pass-through; all the work is in the types). It checks the field KEY, not its MEANING.
