/**
 * Serve the MCP App.
 *
 *   bun run examples/mcp-app/server.ts
 *   # then point an MCP Apps host (MCPJam Inspector, ChatGPT Apps, Goose) at http://localhost:3000/mcp
 *   curl -s localhost:3000/mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
 */
import { app } from "./backend"

// Wrap (not bare `fetch: app.fetch`) so `this` stays bound to the app when Bun invokes the handler.
export default { port: Number(Bun.env.PORT ?? 3000), fetch: (req: Request) => app.fetch(req) }
