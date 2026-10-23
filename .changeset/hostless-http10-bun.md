---
"@nifrajs/core": patch
---

On Bun, an HTTP/1.0 request with no Host is served as `localhost` with its target resolved, as on Node
and Deno. Bun handed such a request over with its target as sent: a relative URL, so a handler that read
`new URL(c.req.url)` threw a 500, and dot segments left unresolved, so its route table matched
`GET /files/..` to `/files/:name` with the parameter `..` and `/users/../posts` missed `/posts`. The fix
covers `fetch`, the native route table and WebSocket handshakes; a request built in process keeps its URL.
