---
"@nifrajs/testing": minor
---

feat(testing): browser-test glue (`serveTestApp`, `e2eUrl`)

`@nifrajs/testing/e2e` covers what in-process testing cannot: a real socket, real
navigation, real rendering. `serveTestApp(app)` binds the app to an ephemeral port
(via the optional `@nifrajs/node` peer) and stops cleanly; `e2eUrl<typeof app>(base,
path)` typechecks the visited path against the route registry, so a typo'd URL fails
typecheck instead of 404ing mid-suite. Login stays in-process through `testSession` -
the session jar crosses into the browser as a `Cookie` header. Bring your own
Playwright/Vitest runner; this is the glue, documented with recipes on `/docs/testing`.
