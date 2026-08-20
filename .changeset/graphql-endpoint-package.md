---
"@nifrajs/graphql": minor
---

Add `@nifrajs/graphql`: mount a GraphQL endpoint on a nifra app. A spec-compliant GraphQL-over-HTTP
handler (`respondGraphql`) you mount at `POST /graphql`, `graphql-transport-ws` subscriptions over
nifra's native WebSocket lane (`graphqlWebSocket`), an in-memory subscription source (`createPubSub`)
you can swap for a durable bus, and a `mountGraphql` one-call helper that wires POST/GET (and,
optionally, subscriptions) while injecting the nifra route context into resolvers. Executes with the
`graphql` package's own `parse`/`validate`/`execute`/`subscribe`; the request body reuses core's single
bounded, prototype-guarded trust boundary. `graphql` is a required peer, `graphql-ws` an optional one.
