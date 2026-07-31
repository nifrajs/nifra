---
"@nifrajs/storage": patch
"create-nifra": patch
---

The beacon wrapper stops breaking adapters that use `#private` fields, and the `--db` sample no longer
collides with a template route.

A `#` field's brand check is per-instance, so a Proxy that passes itself as the receiver throws
`Cannot access invalid private field`. Getters broke on both views and methods broke on the unbound
one - an adapter using `#` worked unwrapped and broke the moment you added beacons. Both proxies now
read against the target, and the unbound one binds methods to it.

The generated `db/read-routes.ts` registered `GET /notes`, which the fullstack template already
registers. `nifra check` associates modules with routes by matching the registered path across your
source, so that unmerged sample lent its `db.read` reach to a template route that never touches the
database - failing the check on a fresh `create-nifra --template fullstack --db …`. The sample uses
`/db/notes` now, and says why.
