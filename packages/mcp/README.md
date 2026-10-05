# @nifrajs/mcp

Build transport-agnostic MCP servers and interactive MCP Apps for Nifra applications.

```sh
bun add @nifrajs/mcp
```

```ts
import { createMcpServer, defineMcpTool } from "@nifrajs/mcp"

const tools = [
  defineMcpTool({
    name: "health",
    description: "Report service health",
    handler: () => ({ text: "ok" }),
  }),
]

const mcp = createMcpServer({
  name: "orders",
  version: "1.0.0",
  tools,
  // Local or private-network server: refuse any other Host (DNS rebinding).
  allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
})
```

Mount `mcp.fetch` at `POST /mcp`. The package also exposes the JSON-RPC protocol and Streamable HTTP
layers directly, plus `defineMcpWidget` and the React adapter for tool results that render UI in MCP
hosts.

MCP servers are same-origin for browser clients by default. Set an exact `allowedOrigins` list for
known cross-origin clients, or set `allowAnyOrigin: true` only for a deliberately public,
secret-free server. Authentication is still the host application's responsibility.

The Origin check cannot stop DNS rebinding: a rebound page reaches the server under the attacker's
hostname, so its Origin matches. For a server on localhost or a private network, set `allowedHosts`
(`host` matches any port, `host:port` one port); every request with an unlisted Host gets 403.
Unset, any Host is accepted.

Clients that include `text/event-stream` in `Accept` receive progress notifications as they happen,
followed by the final JSON-RPC response in the same stream. An SSE `GET /mcp` opens a cancellable
server-message connection; a plain `GET /mcp` remains a health page.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
