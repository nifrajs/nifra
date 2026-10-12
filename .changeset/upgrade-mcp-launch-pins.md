---
"@nifrajs/cli": patch
---

`nifra upgrade --write` moves the MCP launch pin in `.mcp.json`, `.cursor/mcp.json`, `CLAUDE.md` and the `## MCP server` section of `AGENTS.md` to the target version, the same edit `nifra init-agents --sync-mcp` makes, and the dry run lists each one. A symlinked file or folder is left alone. Other versions pinned in `CLAUDE.md` and `AGENTS.md` are listed with their line, alongside the Dockerfiles, CI workflows and other lockfiles the upgrade already lists.
