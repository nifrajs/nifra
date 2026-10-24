---
"@nifrajs/cli": minor
---

`nifra contracts snapshot` warns for each route part whose declared schema it cannot read, which the
lock records as `null` and so never guards. `nifra contracts check` and the `nifra check` contract gate
say whether the request or the response changed, name a route that was added or removed, and report a
side the lock recorded no schema for as newly covered, with the snapshot to run, rather than as a
change. `nifra contracts check --out <file>` reads that lock. `nifra upgrade` notes the locked routes
that send a body but record no request schema.
