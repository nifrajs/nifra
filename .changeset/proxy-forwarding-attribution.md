---
"@nifrajs/proxy": minor
---

`forwardClientIp` now forwards caller metadata only when the proxy can attribute the hop it
observed. Pass a `ProxyContext` and `X-Forwarded-For` is the inbound chain with `c.clientIp`
appended, as before, alongside `X-Forwarded-Proto` and `X-Forwarded-Host`. Hand it a bare `Request`
and there is no observed address to append, so all three headers are suppressed rather than relayed
unchanged - an upstream counting trusted hops from the right never sees a chain this proxy could not
vouch for.

Static `headers` are validated at construction. A hop-by-hop name, a `proxy-` prefixed name, a
forwarding name, or `host` throws a `TypeError` naming the header instead of quietly overwriting the
hygiene pass on every request.
