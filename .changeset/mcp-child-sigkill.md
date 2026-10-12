---
"@nifrajs/cli": patch
---

A cancelled or timed-out `nifra_run`, `nifra_render` or `nifra_ws` call, a replaced warm worker, and a cancelled or timed-out `nifra_hydrate` run now end even when the app catches SIGTERM. The child gets SIGTERM, then SIGKILL two seconds later, as `nifra_test` already did. Before, an app with a SIGTERM handler and a request that never answered kept the tool call waiting forever and left the process running after the MCP server moved on.
