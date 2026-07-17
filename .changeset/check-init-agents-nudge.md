---
"@nifrajs/cli": patch
---

`nifra check` now prints a one-line tip when the project has no `.mcp.json`, pointing at `nifra init-agents` (which wires `.mcp.json` + `.cursor/mcp.json` + a CLAUDE.md preamble, no-clobber). The tip is non-fatal and only in the human report - the `--json` path is unchanged - so a coding agent discovers the MCP wiring instead of learning the framework from sibling-app source.
