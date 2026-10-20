---
"@nifrajs/middleware": minor
"@nifrajs/core": patch
"@nifrajs/client": patch
"@nifrajs/web": patch
---

Harden idempotency replay admission and reservation handling, rate-limit capacity, and SSE resource limits.

Idempotency must be installed after authorization guards and before its protected routes; late installation now throws. Replays without an admission marker are refused. Oversized responses retain terminal replay records, active leases renew when supported, and lost reservations no longer report success. Stores without renewal reserve pending work for at least the replay retention TTL.

The `idempotency()` return type is now `IdentityPlugin` rather than `Middleware`. Existing `.use(idempotency(...))` calls keep their spelling. Replace explicit `Middleware` annotations on the returned plugin with `IdentityPlugin` from `@nifrajs/core`, or let TypeScript infer the type; install the plugin directly with `.use()` instead of extracting its middleware hooks.

Rate-limit capacity refuses new keys while preserving live quotas. SSE checks each encoded frame against the remaining byte budget, and the client stops reconnecting after HTTP 204. Server-component builds resolve public environment values consistently for browser defines and generation hashing.
