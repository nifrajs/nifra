---
"@nifrajs/middleware": patch
---

`idempotency()` replays a stored response from `beforeHandle` when the route that produced it is declared after `.use(idempotency())`, so a retry passes the route's authentication, validation and earlier `beforeHandle` guards again first: a credential revoked or expired since the first request gets the route's current answer, not the stored one. The key is still claimed in `onRequest`, so an in-flight collision answers 409 as before. Stored records carry `recheck: true` for such routes; a record without it, from a route declared before the middleware or an earlier version, is replayed in `onRequest` as before.
