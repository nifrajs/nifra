---
"@nifrajs/mcp": minor
"@nifrajs/mcp-db": minor
---

feat(mcp): `allowedHosts` DNS-rebinding guard

`createMcpServer()`, `respondMcpHttp()`, and `serveDatabaseAsMcp()` accept `allowedHosts`. A
request whose Host is not listed gets 403, with or without an Origin. Set it for servers on
localhost or a private network, where a DNS-rebound page presents a matching Origin.

The same-origin default now accepts an `https:` Origin on an `http:` request URL (a TLS-terminating
proxy) and still rejects a downgrade.
