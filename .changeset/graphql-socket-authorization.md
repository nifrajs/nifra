---
"@nifrajs/graphql": minor
---

`mountGraphql({ subscriptions: true })` admits a socket only when `authorize` accepts its upgrade request, and applies the HTTP query limits (`maxQueryBytes`, `maxDepth`, `executionTimeoutMs` and the rest) to operations over it. Before, `subscriptions: true` reused only `schema` and `context`, so a socket could run queries and mutations that HTTP refused. When `authorize` is set and `subscriptions` is an options object with neither `authorize` nor `onConnect`, `mountGraphql` throws instead of admitting every socket. `graphqlWebSocket` takes a new `authorize(request)` option, checked before `onConnect`.
