---
"@nifrajs/cli": patch
---

`nifra fix` with no `--code` no longer rewrites `contracts.lock.json` or migrates the project layout. Both accept a change a person should review first, so a bare `nifra fix` lists them under `skipped` with the command that applies each; `nifra fix --code NF-K001` still re-snapshots the lock.
