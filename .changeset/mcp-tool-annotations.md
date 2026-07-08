---
"@nifrajs/core": minor
"@nifrajs/mcp": minor
---

feat: MCP tool annotations on `server().tool()`

`.tool()` config now accepts `annotations` — the MCP spec's per-tool safety hints (`title`, `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`) — surfaced in `tools/list` and `tools/describe`. An
agent can now tell a read-only tool from a destructive one and decide whether to auto-invoke or confirm
first, instead of treating every exposed tool as equally risky.
