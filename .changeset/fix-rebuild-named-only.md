---
"@nifrajs/cli": patch
---

`nifra fix` (and MCP `nifra_fix`) with no `--code` no longer rebuilds a stale workspace-linked package. That fix runs the linked package's own build script in its directory, outside the project the command was given. A bare run now lists the finding under `skipped`, and `nifra fix --code NF-C010` still rebuilds it.
