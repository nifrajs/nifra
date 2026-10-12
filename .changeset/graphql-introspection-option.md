---
"@nifrajs/graphql": patch
---

New `introspection` option on `respondGraphql`, `mountGraphql` and `graphqlWebSocket`. Set it to `false` and a query that reads `__schema` or `__type` fails validation: over HTTP it answers 400 with a GraphQL error, and over a socket the operation gets an `error` frame. `__typename` still resolves. With `mountGraphql`, subscriptions inherit the setting unless their own WS options set it. Before, introspection was always answered, on both transports. The default stays `true`.
