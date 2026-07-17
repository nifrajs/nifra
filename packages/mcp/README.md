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

const mcp = createMcpServer({ name: "orders", version: "1.0.0", tools })
```

Mount `mcp.fetch` at `POST /mcp`. The package also exposes the JSON-RPC protocol and Streamable HTTP
layers directly, plus `defineMcpWidget` and the React adapter for tool results that render UI in MCP
hosts.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
