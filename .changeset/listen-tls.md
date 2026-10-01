---
"@nifrajs/core": minor
"@nifrajs/node": minor
"@nifrajs/deno": minor
---

feat(core): `tls` serves HTTPS straight from the process, on Bun, Node and Deno.

```ts
import { readFileSync } from "node:fs"

const tls = { cert: readFileSync("cert.pem"), key: readFileSync("key.pem") }

app.listen(443, { tls }) // Bun
await serve(app, { port: 443, tls }) // @nifrajs/node or @nifrajs/deno
```

`cert` and `key` are PEM, as text or the files' bytes. Requests then arrive with `https:` URLs, and
WebSocket upgrades use the same port. Bun also takes `passphrase` for an encrypted key. On Node,
`tls` accepts any `node:tls` server option (`ca` and `requestCert` for client certificates,
`minVersion`, `SNICallback`), and the request protocol defaults to `https` when it is set. Without
`tls`, each runtime serves plain HTTP, which is what a proxy or platform that ends TLS expects.
