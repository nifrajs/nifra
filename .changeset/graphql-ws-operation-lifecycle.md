---
"@nifrajs/graphql": patch
---

`graphqlWebSocket` frees an operation's `maxSubscriptions` slot when the server completes it or ends it with an error, not only when the client sends `complete`. An `onConnect` that throws refuses the connection with 4403, as returning `false` does. An operation that runs past `executionTimeoutMs` ends with an error result and leaves the connection open, and any other failure in a frame closes that one socket with 4500.
