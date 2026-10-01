---
"@nifrajs/cli": minor
---

feat(cli): `nifra init-agents` at a workspace root names its nifra member in the MCP launch. When the
root is not itself a nifra project and exactly one workspace member is, the `.mcp.json` and
`.cursor/mcp.json` it writes launch `mcp <member>`, and `--sync-mcp` adds the member to an existing
launch that names no directory. A launch that already names one keeps it, the markdown launch commands
keep their wording, and with several nifra members nothing is named. `--sync-mcp` also pins to the
member's installed nifra when the root has none, as in an isolated install.
