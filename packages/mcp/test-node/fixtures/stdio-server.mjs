import { createMcpServer } from "@nifrajs/mcp"
import { serveStdio } from "@nifrajs/mcp/stdio"

await serveStdio(
  createMcpServer({
    name: "stdio-node-fixture",
    version: "0.0.0",
    tools: [
      {
        name: "echo",
        description: "Echo the arguments",
        inputSchema: { type: "object" },
        handler: async (args) => JSON.stringify(args),
      },
    ],
  }),
)
