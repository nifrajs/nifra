---
"@nifrajs/core": minor
---

The unused order-scoped hook check (`unusedScopedHooks`) now reports three more silent gaps, in development and test only:

- A hook followed only by `merge()` calls. A merged route keeps the hooks of the server that declared it, so `app.use(session).merge(users)` ran `session` on none of the merged routes and was never reported, because the merged routes counted as routes declared after the hook. The report marks such a hook "only merge()d routes follow it".
- `authenticate()`, which the check did not record at all.
- `responseContract()` or `effectLedger()` installed after routes it would have covered: a route declaring a response, or capabilities, registered or merged before the install. Both are decided per route at registration, so those routes ran without them. The report names up to five of them.

With `unusedScopedHooks: "error"` each of these now throws `UNUSED_SCOPED_HOOKS` at the first request or `listen()`, as a dead `derive()` already did. A production build drops the check.
