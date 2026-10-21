---
"@nifrajs/core": patch
---

A route with several hooks, either validation order, or an asynchronous validator, hook or handler creates fewer promises per request, and an `auth-before-validation` route whose hooks and validators are all synchronous answers synchronously. On Bun, the native route table runs every eligible route's full lifecycle directly, not only the closed fast shapes, with its validation, hooks, recovery and error handling unchanged. A query string without `%` or `+` parses faster.

On Bun's `listen()`, a custom body validator that throws now reaches the route's `onError` hooks, as it already did through `fetch` and on Node, instead of being answered as malformed JSON with a 400.

A response that an asynchronous response-contract check accepts but that cannot be rendered (a `BigInt`, a cycle) now reaches `onError` in every validation order. Before, a synchronous handler on a `validate-before-auth` route rejected the request's promise instead.
