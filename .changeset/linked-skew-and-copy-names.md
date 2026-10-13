---
"@nifrajs/core": patch
"@nifrajs/cli": minor
---

`nifra upgrade` stops before writing anything when a `link:` or `file:` dependency outside the project installs its own `@nifrajs/*` at a version other than the target. Its imports resolve from its own `node_modules`, so after the upgrade a `server()` it builds could no longer be merged into the app, and that only failed at the first `merge()`. The refusal names each linked repository, its versions and the commands that upgrade it; `--allow-linked-skew` upgrades the project anyway. A dry run prints the plan with the same blocker and exits non-zero. A linked copy that resolves back into the project follows its install and does not count.

`merge()` given a server from another loaded copy of `@nifrajs/core` names every copy in its error, this one first, with the version of each copy that has built a `server()`, and says how to collapse them. With one copy loaded the message is unchanged. Copies older than this release are named by path alone, and a production build keeps the short message.
