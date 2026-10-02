---
"@nifrajs/ts-plugin": minor
---

feat(ts-plugin): the frontend/backend zone rules as editor errors

A value import the build would refuse is an error on the import itself: backend code or a route's
backend half in a page or under `frontend/`, frontend code under `backend/`, anything but shared code
under `shared/`, and a Node or Bun built-in, a server package or `@nifrajs/web/backend-only` in browser
code. `import type` is always allowed, and files in no zone (tests, scripts, config) are not checked.
The rules are `@nifrajs/web/zones`, the classifier the builds and `nifra check` use.
