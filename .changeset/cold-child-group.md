---
"@nifrajs/cli": patch
---

A process the project starts no longer outlives an MCP call that loaded it. The cold `nifra_run`, `nifra_render` and `nifra_ws` path, the isolated project child behind `nifra mcp`'s project tools and resources, the database tools and the hydration run now stop the child's process group once the child exits (SIGTERM, then SIGKILL after the grace period), as the warm worker already did. A helper that inherited the child's stderr also held the call open until its deadline (30 s for a cold run) or, for a project tool call, which has none, until the helper exited; the call now returns when the child does.
