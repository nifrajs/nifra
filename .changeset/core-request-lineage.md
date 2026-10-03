---
"@nifrajs/core": minor
"@nifrajs/middleware": patch
"@nifrajs/otel": patch
---

`replacedRequestOf(request)` returns the request an `onRequest` hook replaced with this one. Response hooks receive the request the route ran with, so a middleware that keyed state on the request its `onRequest` saw can walk back to it. `idempotency()` uses this to keep its claim when a later hook such as `methodOverride()` rewrites the request: a retry replays the stored response instead of answering 409 and then running the handler a second time. `metrics()` uses it to count such requests and to decrement its in-flight gauge for them.
