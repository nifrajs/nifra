---
"@nifrajs/core": patch
---

`clientIp: { trustedHops: n }` reads the caller from the same `X-Forwarded-For` entry whether or not the adapter observed a socket peer. With no peer (Workers and edge handlers, Bun on a unix socket, a Node socket already closed) it took the entry one place to the left, which the client itself wrote, so `c.clientIp` and everything keyed on it could be forged. With no peer, `trustedHops: 0` is now `undefined` rather than the rightmost header entry.
