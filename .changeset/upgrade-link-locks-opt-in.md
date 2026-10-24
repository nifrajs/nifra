---
"@nifrajs/cli": minor
---

`nifra upgrade --write` leaves bun.lock as it is. It lists the `file:` entries whose recorded
dependencies Bun never refreshes, with the `bun update` that refreshes them; `--prune-link-locks`
drops them instead. Either way the next install reads each linked package.json as it is on disk, so
the report asks for a review of the bun.lock diff before it is committed.
