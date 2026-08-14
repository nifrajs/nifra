---
"@nifrajs/cli": patch
---

`nifra check` now prints an advisory when the contract lock is vacuous - every route hashes to the
empty-schema digest because no route declares a `body`, `query`, `params`, or `response` schema. Such a
lock passes drift detection unconditionally: it can only ever compare an empty schema to an empty
schema, so it guards nothing. The advisory says so and points at declaring route schemas, so a first
run on an unschematized app does not leave a lock that looks protective but is not. A lock with no
routes at all is not treated as vacuous, since there is no unguarded contract to warn about.
