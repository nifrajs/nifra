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

Mount `mcp.fetch` at `/mcp` for `GET`, `POST` and `OPTIONS`:

```ts
import { method } from "@nifrajs/core/methods"
import { server } from "@nifrajs/core/server"

const app = server().use(method(["GET", "POST", "OPTIONS"], "/mcp", (c) => mcp.fetch(c.req)))
```

`OPTIONS` carries a cross-origin browser client's CORS preflight to the server's own origin policy;
without it the preflight gets a 405. The package also exposes the JSON-RPC protocol and Streamable HTTP
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

## stdio

A command an agent launches (`"command": "my-server"` in its MCP config) talks over stdin and stdout
instead. `serveStdio` runs the same server that way, on Bun, Node or Deno:

```ts
import { serveStdio } from "@nifrajs/mcp/stdio"

await serveStdio(mcp)
```

It resolves when stdin ends and every pending request has answered. Whoever can write to the process's
stdin can call every tool, so the HTTP origin, host and `authorizeMessage` options do not apply. Write
logs to stderr: anything else on stdout corrupts the stream. `runStdioTransport` is the framing layer
underneath, for a host that dispatches messages itself.

## Widgets on Node and Deno

A React widget from `@nifrajs/mcp/react` is bundled with `Bun.build`. For a server that runs on Node
or Deno, bundle it at build time with `bundleReactWidget({ component })`, ship the returned body as a
file, and pass that file's text to `defineMcpWidget({ uri, name, html })` at run time.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
