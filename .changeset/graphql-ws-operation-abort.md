---
"@nifrajs/graphql": minor
---

Each `graphqlWebSocket` operation runs with an abort signal that resolvers read through graphql's `info.getAbortSignal()`. It is aborted when the operation passes `executionTimeoutMs`, when the client sends `complete`, and when the socket closes. A subscription source that a resolver still produces after that abort is returned, so its cleanup runs.
