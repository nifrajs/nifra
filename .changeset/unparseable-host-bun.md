---
"@nifrajs/core": patch
---

On Bun, a request Bun.serve received with a Host no URL can be built on (a space, a byte past ASCII,
an empty value, a path, a port past 65535) answers 400 `invalid_host`, as on Node and Deno. Bun left
the target unparsed for such a Host, so a handler or `upgrade()` that read `new URL(c.req.url)` threw
a 500. The check covers the native route table and WebSocket handshakes too; a request built in
process keeps the URL its caller built, whatever its Host header says.
