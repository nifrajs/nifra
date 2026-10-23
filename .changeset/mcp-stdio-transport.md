---
"@nifrajs/mcp": minor
"@nifrajs/cli": patch
---

`@nifrajs/mcp/stdio` serves an MCP server over stdin and stdout on Bun, Node and Deno: `serveStdio(createMcpServer({ ... }))` resolves once stdin ends and every pending request has answered, with progress notifications and request cancellation as over HTTP. `runStdioTransport` is the newline-delimited JSON-RPC framing underneath, with an 8 MiB cap per message in each direction.

`nifra mcp` now runs on the same transport, which changes four edge cases:

- A line that is not valid UTF-8 is answered with `-32700 parse error` and not dispatched; the invalid bytes were previously replaced with U+FFFD and the message ran.
- A notification whose handler throws gets no reply, as JSON-RPC requires; it previously got an error response with a `null` id.
- A last line without a trailing newline when stdin closes is processed; it was previously dropped.
- When stdin closes, requests still running answer before the warm workers shut down; the workers previously closed at once.
