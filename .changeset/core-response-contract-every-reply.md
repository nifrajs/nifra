---
"@nifrajs/core": patch
---

`responseContract()` now holds every `status(...)` and `c.json(...)` reply to the route's declared schema, not only the one the handler returns. A reply the handler throws, a reply a `derive` or `beforeHandle` hook returns early, and a reply `onError` answers with used to reach the wire unchecked, undeclared fields included. They are now validated like a returned one: `enforce` strips or refuses them, `warn` logs them. If a schema throws while checking an `onError` reply, the request answers 500 instead of running `onError` again. A hand-built `Response` still passes unchecked.
