---
"@nifrajs/graphql": minor
---

Every document limit runs before `validate()`. The new `maxFieldOverlaps` (default 2,000) bounds the pairs of fields sharing a response name in one selection set, counted through inline fragments and fragment spreads; graphql-js's overlap validation compares every such pair, so a few kilobytes of repeated fields within the depth and complexity limits no longer hold the event loop for seconds. A fragment no operation uses is refused before validation too. Over a WebSocket, a `subscribe` frame sent before `connection_init` is admitted goes straight to graphql-ws, which closes the socket with `4401` without reading the query: no validation errors, and so no field-name suggestions, reach an unauthenticated socket.
