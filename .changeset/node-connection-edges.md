---
"@nifrajs/node": patch
---

- `c.req.signal` aborts when the client disconnects before the response finished, matching Bun and Deno.
- A peer that resets the connection while an async WebSocket `upgrade` guard runs no longer ends the process.
- On Node versions with `shouldUpgradeCallback`, a request whose `Upgrade` header is not a WebSocket handshake (such as curl's `h2c` offer) is served as an ordinary HTTP request instead of answered 404.
