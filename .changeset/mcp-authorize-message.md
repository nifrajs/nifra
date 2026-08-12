---
"@nifrajs/mcp": minor
---

New `authorizeMessage` option on `createMcpServer` (and per request via
`mcp.fetch(request, { authorizeMessage })`): a hook run once per parsed message, before any tool runs,
that answers `403` with a JSON-RPC `unauthorized` error (`MCP_ERROR.UNAUTHORIZED`) when it returns
`false`. The HTTP layer above an MCP mount only ever sees one opaque POST, so a route guard cannot
express "this caller may list tools but may not call the write ones" - this is the seam that can. It
runs after the body has been read under `maxBodyBytes`, so it costs no second read of the stream.
