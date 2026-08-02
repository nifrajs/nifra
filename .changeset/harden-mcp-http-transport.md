---
"@nifrajs/mcp": minor
---

Harden the Streamable HTTP transport so a hosted MCP server loads cleanly as a remote connector. The CORS preflight now allows the request headers browser-based clients send (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Authorization`, `Accept`, `Last-Event-ID`) and exposes the protocol-version header. `initialize` negotiates the protocol version, echoing the client's requested revision when the server also speaks it. Notifications are acknowledged with `202 Accepted`; a `GET` that requests `text/event-stream` returns `405`; and `respondMcpHttp` gains an `allowedOrigins` option that rejects any other browser origin with `403` as a DNS-rebinding guard (omitted by default, so a public server stays open).
