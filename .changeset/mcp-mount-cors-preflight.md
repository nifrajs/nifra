---
"@nifrajs/mcp": patch
---

The documented nifra mount for `createMcpServer` routes `OPTIONS` as well as `GET` and `POST`: `server().use(method(["GET", "POST", "OPTIONS"], "/mcp", (c) => mcp.fetch(c.req)))`. A browser client on another origin sends a CORS preflight before its first POST, and that route lets `allowAnyOrigin` or `allowedOrigins` answer it. A mount with only `GET` and `POST` routes answers the preflight with 405, so the browser never sends the POST.
