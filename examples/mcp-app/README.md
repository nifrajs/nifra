# mcp-app — an MCP App built with nifra

A normal nifra backend that also exposes an **MCP server** with an **interactive `ui://` widget**
([MCP Apps / SEP-1865](https://github.com/modelcontextprotocol/ext-apps)) at `POST /mcp`. Calling the
`list_orders` tool renders an interactive orders table in MCP Apps hosts (MCPJam, ChatGPT Apps, Goose).

```bash
bun run examples/mcp-app/server.ts
# headless check — drive the JSON-RPC endpoint directly:
curl -s localhost:3000/mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
curl -s localhost:3000/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_orders"}}'
```

To see the widget render, point an MCP Apps host at `http://localhost:3000/mcp` — e.g. the
[MCPJam Inspector](https://www.mcpjam.com): `npx @mcpjam/inspector`. (Claude Code's terminal doesn't
render `ui://` widgets; it shows the tool's text result instead.)

Or open a browser straight at the bundled **host harness** (plays the host side of the bridge so the
real widget renders without an MCP host):

- `http://localhost:3000/` — the HTML widget (`ui://orders/table`, from `widget.ts`)
- `http://localhost:3000/react` — the same widget authored as a React component
  (`OrdersTableWidget.tsx` via `@nifrajs/mcp/react`)

## How it works

- [`widget.ts`](widget.ts) — `defineMcpWidget` builds the `ui://orders/table` widget: one self-contained
  HTML document served as `text/html;profile=mcp-app`, with the bridge inlined. The author writes plain
  markup + `mcpApp.onData(render)` (render the host-pushed `structuredContent`) and `mcpApp.callTool(...)`
  (the "Refresh" button re-invokes the tool through the host).
- [`backend.ts`](backend.ts) — `defineMcpTool({ widget })` links the tool to the widget; `createMcpServer`
  registers it and advertises the UI capability. The nifra app mounts it with
  `.get("/mcp", c => mcp.fetch(c.req)).post("/mcp", c => mcp.fetch(c.req))`.
- [`OrdersTableWidget.tsx`](OrdersTableWidget.tsx) — the same widget as a React component;
  [`@nifrajs/mcp/react`](../../packages/mcp/src/react.ts)'s `reactWidget` bundles it for the browser.
- [`host-demo.ts`](host-demo.ts) — the tiny host harness behind `GET /` and `GET /react`.
- [`server.ts`](server.ts) — serves the app on `:3000`.

Everything is `@nifrajs/mcp` (+ `react` for the React widget); no other dependency.
