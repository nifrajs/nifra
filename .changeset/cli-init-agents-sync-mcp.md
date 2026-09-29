---
"@nifrajs/cli": patch
---

feat(cli): `nifra init-agents --sync-mcp` re-pins the `@nifrajs/cli@x.y.z` MCP launch in `.mcp.json`,
`.cursor/mcp.json`, `CLAUDE.md` and the `## MCP server` section of `AGENTS.md` to the nifra the
project installs. Only the version changes; every other byte stays as it is, no file is created, and
a second run is a no-op. The CLI-version drift warnings from `nifra mcp` and `nifra doctor` recommend
it, `nifra doctor` flags a stale pin even when the CLI itself matches, and a plain `nifra init-agents`
run points any kept file with a stale pin at the flag.
