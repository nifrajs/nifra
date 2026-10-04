---
"@nifrajs/cli": patch
---

The hydration gate (`nifra assure --hydration`, `nifra_hydrate`, hydration replays) no longer reports a false NF-H001 when a project's config or loader prints to stdout: the runner's answer travels on its own tagged line, and `console.log` output from project code goes to stderr. A run now stops after five minutes, `nifra_hydrate` stops when the MCP call is cancelled, and the runner's output is bounded.
