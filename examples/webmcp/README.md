# WebMCP + predictive UI

This example keeps one typed capability as the source of truth and projects it to both agent
surfaces:

- `registerWebMcpTools([addToCart])` exposes an explicit page-local WebMCP allowlist when the host
  supports `document.modelContext.registerTool`.
- `toMcpTool(addToCart.tool)` exposes the same validated and authorized core tool through the existing
  remote MCP adapter when the page is not open.
- `executePredicted` applies a deterministic local patch, executes the server-backed tool, and accepts
  or rolls back the authoritative state.

The example is intentionally host-neutral. In a browser, call `installCartTools()` from the page
entrypoint. In a server, add `remoteCartTool` to an existing `createMcpServer({ tools: [...] })` list.
WebMCP support is optional; the human UI still owns rendering and works on an ordinary browser.

```bash
bun run typecheck
bun test packages/webmcp/test
```
