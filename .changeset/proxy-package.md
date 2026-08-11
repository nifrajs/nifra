---
"@nifrajs/proxy": minor
---

New package: a dependency-free reverse proxy to one fixed upstream origin. `createProxy({ upstream })` returns a handler that streams both directions and mounts with `mountFetch` or inside any route. The upstream is a bare origin validated at construction and the forwarded URL is built by mutating a clone of it - request input can never change which host is dialed. Hop-by-hop and `Connection`-nominated headers are stripped in both directions, `Forwarded`/`X-Forwarded-*` metadata is dropped unless `forwardClientIp: true` (which appends the observed caller truthfully), upstream redirects are never followed, TLS verification cannot be disabled, and failures answer flat errors: `502 bad_gateway` unreachable, `504 gateway_timeout` on the `timeoutMs` deadline (default 30s). `stripPrefix` and static override `headers` are supported. WebSocket upgrade is not proxied.
