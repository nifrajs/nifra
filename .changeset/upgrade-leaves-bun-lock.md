---
"@nifrajs/cli": minor
---

`nifra upgrade --write` leaves bun.lock as it is, where it dropped the stale `file:` entries before:
an install that finds one missing re-resolves every package in the lock to the newest version its
range allows, and Bun 1.4.4 also rewrites a lockfileVersion 1 lock as 2. The report lists those
entries with the `bun update` that refreshes them and keeps every other pin, and asks for a review of
the bun.lock diff, since Bun records each linked package.json as it is on disk. The `--json` plan no
longer carries `lockPruned`, and NF-D003 names `bun update` as its only fix.
