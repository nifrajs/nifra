---
"@nifrajs/node": patch
---

On Node, a handler that reads `c.req.body` through its reader (or cancels it) can then read `c.req.signal`, `c.req.bodyUsed` and the rest of the request, as on Bun; this answered 500 before. `bodyUsed` is `true` after such a read. An MCP server mounted with `mcp.fetch(c.req)` reads its body this way, so every MCP POST on Node answered 500.
