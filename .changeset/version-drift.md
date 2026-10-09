---
"@nifrajs/cli": minor
---

`nifra doctor` and `nifra check` report mixed nifra versions in one workspace. They read the
versions pinned in `package.json` files, the versions installed in `node_modules` (followed to their
real location, so a linked repository reports its own) and the running CLI. When more than one
version appears, doctor prints an advisory naming each version and its source, and check reports
`NF-D002` (info) with the fix `nifra upgrade <highest>`, which runs each release's migration steps
before re-pinning. Neither fails the run, and both only read files.

The `nifra upgrade` plan now lists group packages linked from outside the workspace root under
"Left alone" (`UpgradePlan.linkedOutside`). The upgrade edits only files under the root and never
follows a symlinked package directory or `package.json`.
