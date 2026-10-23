---
"@nifrajs/mcp": minor
"@nifrajs/cli": patch
---

`@nifrajs/mcp/stdio` serves an MCP server over stdin and stdout on Bun, Node and Deno: `serveStdio(createMcpServer({ ... }))` resolves once stdin ends and every pending request has answered, with progress notifications and request cancellation as over HTTP. `runStdioTransport` is the newline-delimited JSON-RPC framing underneath, with an 8 MiB cap per message in each direction. `nifra mcp` now runs on the same transport; a line that is not valid UTF-8 is answered as a parse error, and a failing notification gets no reply.
