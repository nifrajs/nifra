---
"@nifrajs/graphql": minor
---

A GraphQL POST whose `Content-Type` is not `application/json` (or another `+json` type) answers `415` before its body is read. Before, an urlencoded, multipart or `text/plain` body was parsed and executed, so a cross-site HTML form could post a mutation with the visitor's cookies. Clients that send JSON without a `Content-Type` header must now set it.
