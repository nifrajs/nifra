---
"@nifrajs/core": patch
---

A route with several hooks, either validation order, or an asynchronous validator, hook or handler creates fewer promises per request, and an `auth-before-validation` route whose hooks and validators are all synchronous answers synchronously. On Bun, the native route table runs every eligible route's full lifecycle directly, not only the closed fast shapes, with its validation, hooks, recovery and error handling unchanged. A query string without `%` or `+` parses faster.

A custom body validator that throws now reaches the route's `onError` hooks like any other lifecycle error, instead of being answered as malformed JSON with a 400.
