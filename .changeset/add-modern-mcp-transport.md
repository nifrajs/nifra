---
"@nifrajs/mcp": minor
---

Add the 2026-07-28 modern MCP transport alongside the handshake, so a server speaks both eras on one endpoint. It implements `server/discover` (advertising supported versions, capabilities, and identity), per-request protocol-version negotiation (an `UnsupportedProtocolVersionError` for a version the server does not speak), the `resultType` completion envelope with cache hints on list/read results, and - over HTTP - validation of the mirrored `Mcp-Method`/`Mcp-Name`/`MCP-Protocol-Version` headers against the request body (a `HeaderMismatch` answered with 400) plus the spec's status codes (404 for an unknown method). Clients that still use the `initialize` handshake are served exactly as before. `createMcpServer` and the HTTP handler gain an `instructions` field surfaced in discovery.
