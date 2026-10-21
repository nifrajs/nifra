---
"@nifrajs/middleware": minor
"@nifrajs/core": minor
"@nifrajs/client": patch
"@nifrajs/web": patch
---

Harden idempotency replay admission and reservation handling, rate-limit capacity, and SSE resource limits.

Idempotency covers the routes declared after it; installing it after any route that uses a covered method throws. A replay runs just before the handler, once the route's authentication, validation and every guard, registered before or after the middleware, admit the retry. A request no covered route handles, such as one a mounted app answers, releases its key. Replays without an admission marker are refused. Oversized cacheable responses retain terminal replay records, active leases renew for up to the replay retention TTL when supported, and lost reservations no longer report success. Stores without renewal reserve pending work for at least the replay retention TTL.

`beforeHandler()` from `@nifrajs/core/server` marks a `beforeHandle` hook to run just before the handler, after every guard on the route, including guards registered after it in the same scope.

The `idempotency()` return type is now `IdentityPlugin` rather than `Middleware`. Existing `.use(idempotency(...))` calls keep their spelling. Replace explicit `Middleware` annotations on the returned plugin with `IdentityPlugin` from `@nifrajs/core`, or let TypeScript infer the type; install the plugin directly with `.use()` instead of extracting its middleware hooks.

Rate-limit capacity refuses new keys while preserving live quotas, and each capacity check resumes its bounded scan for expired windows where the last one stopped. SSE checks each encoded frame against the remaining byte budget, and the client stops reconnecting after HTTP 204. Server-component builds resolve public environment values consistently for browser defines and generation hashing.
