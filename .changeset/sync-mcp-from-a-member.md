---
"@nifrajs/cli": minor
---

`nifra init-agents --sync-mcp` and `nifra upgrade --write`, run in a workspace member, also re-pin the MCP launch in the directories above it, up to the repository root: a root `.mcp.json` that launches `mcp app` is the member's to re-pin. A file is rewritten only when every nifra launch in it serves that member, resolved the way `nifra mcp` resolves it; a file that also launches another project, holds a pin no launch accounts for, or is a symlink is reported and left alone. Outside a repository nothing above the project is read.
