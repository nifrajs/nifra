---
"@nifrajs/core": major
"@nifrajs/middleware": major
"@nifrajs/cli": minor
"@nifrajs/web": patch
---

Required `basicAuth`, `bearer`, `apiKey` and `jwt` refuse in the `authenticate()` stage: before the body is read or validated and before any `derive` or `beforeHandle`. An unauthenticated request gets the 401 and its challenge, never a 413 or a 422, on every route shape, lane and WebSocket handshake. With valid credentials an invalid body is still a 422. `optional: true` never refuses and keeps validation first. A `verify` that throws in required mode is a 503. A rate limiter written as a `beforeHandle` behind these guards no longer sees refused requests; `rateLimit()` runs in `onRequest` and still counts them.

The `authenticate()` input adds `params`, the raw `search`, the parsed and frozen `query` (the parser `c.query` uses; a repeated key is an array) and the `request` (its body must not be read). The query is for short-lived, single-use tickets, such as one for a WebSocket handshake.

Project evidence and reflection keep a route's chosen `validationOrder`.

`nifra check` reports a route that claims runtime authentication, declares an input schema and authenticates in a hook that runs after validation (NF-S008, warning). It reads the backend the contract-lock check loads, so it runs when `contracts.lock.json` exists. Fix it with `authenticate()`, or with `validationOrder: "auth-before-validation"` on the route.

The dev feed (`nifra_logs`, `nifra_errors`, request traces and the persisted log) records a query's keys and never its values.
