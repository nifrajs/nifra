---
"@nifrajs/web": patch
"@nifrajs/cli": patch
---

`nifra context`, the MCP route tools and a served `llms.txt` now print the same typed-client call for a route. A `QUERY` route is a `.$query(body, { query })` call: `nifra context` printed a plain `fetch` for it, and `llms.txt` a `.query()` call the client does not have. `nifra context` now keeps a `DELETE` route's body in its options (`.delete({ body })`), and `llms.txt` prints a path segment spelled `$query` as a call on its parent node, as it already did for the other reserved client keys. A WebSocket route is printed as the `.ws()` call that returns its handle, unawaited: `nifra context` printed a `fetch` for it, and `llms.txt` an awaited `.ws()`.
