---
"create-nifra": minor
---

A scaffolded app can run the gate it ships with.

Every template writes `nifra.assurance.ts` - an armed policy that refuses an unauthenticated write, a
mutation with no body schema, and a route reaching a database it never declared. None of them had a way
to run it: no `check` script anywhere, and the two backend templates did not even depend on
`@nifrajs/cli`, so `nifra check` was not on PATH without a manual install.

Every template now has `"check": "nifra check"` and the CLI in devDependencies, and the generated
GitHub workflow (`--ci github`) runs it before the build. A test asserts the invariant: a template that
ships an assurance config must ship both.
