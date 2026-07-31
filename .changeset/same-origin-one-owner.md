---
"@nifrajs/core": patch
"@nifrajs/web": patch
---

The same-origin check works behind a TLS-terminating proxy, and both seams that use it now agree.

Nifra had two of these - the WebSocket handshake's cross-origin default and the server-function mount -
and they answered differently for one request, so a browser that could open a socket was told its POST
was cross-origin. `isSameOriginRequest` from `@nifrajs/core/server` is now the single owner.

The rule it encodes: the host must match, and the Origin's scheme may be equal or STRONGER, never
weaker. A server behind Cloudflare, a tunnel or an ingress sees a plain HTTP socket, so `request.url`
says `http:` while the browser correctly reports an `https:` page - the shape almost every deployment
produces. Comparing full origins rejects it, which is not the stricter option but an outage: measured,
every server-function POST returned 403 behind a terminating proxy, while the cross-origin caller the
comparison aimed at had already been rejected on the host alone. The reverse - an `http:` page against
an `https:` request URL - is a downgrade with no legitimate cause, and is refused, as is any Origin
that is not an http(s) page origin at all.

`X-Forwarded-Proto` is still not read, and that is the point: a forwarded header is attacker-controlled
unless something upstream is proven to overwrite it, so trusting one by default would hand every
unproxied deployment a spoofable origin check. Ordering the two schemes reconciles them without it.
