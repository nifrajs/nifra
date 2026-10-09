---
"@nifrajs/core": minor
---

`securityBaseline()` treats a route under a custom method, such as `PURGE` registered with `method()`, as a mutation. It used to match no rule, so an authenticated custom-method route was never asked to prove CSRF. Every method but GET, HEAD and OPTIONS is now held to the mutation rules; WebSocket routes are still not. Assurance rules gain an `exceptMethods` selector for this ("every method but these"), evidence declarations gain `exceptMethods` and may name custom methods in `methods`, and `@nifrajs/core/methods` exports `isRegistrableMethod`.
