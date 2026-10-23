import { createMcpServer } from "../../src/server.ts"
import { serveStdio } from "../../src/stdio.ts"

await serveStdio(
  createMcpServer({
    name: "stdio-fixture",
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
