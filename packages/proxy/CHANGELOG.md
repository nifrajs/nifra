# @nifrajs/proxy

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

### Minor Changes

- 0a91064: `forwardClientIp` now forwards caller metadata only when the proxy can attribute the hop it
  observed. Pass a `ProxyContext` and `X-Forwarded-For` is the inbound chain with `c.clientIp`
  appended, as before, alongside `X-Forwarded-Proto` and `X-Forwarded-Host`. Hand it a bare `Request`
  and there is no observed address to append, so all three headers are suppressed rather than relayed
  unchanged - an upstream counting trusted hops from the right never sees a chain this proxy could not
  vouch for.

  Static `headers` are validated at construction. A hop-by-hop name, a `proxy-` prefixed name, a
  forwarding name, or `host` throws a `TypeError` naming the header instead of quietly overwriting the
  hygiene pass on every request.

- cc787e3: New package: a dependency-free reverse proxy to one fixed upstream origin. `createProxy({ upstream })` returns a handler that streams both directions and mounts with `mountFetch` or inside any route. The upstream is a bare origin validated at construction and the forwarded URL is built by mutating a clone of it - request input can never change which host is dialed. Hop-by-hop and `Connection`-nominated headers are stripped in both directions, `Forwarded`/`X-Forwarded-*` metadata is dropped unless `forwardClientIp: true` (which appends the observed caller truthfully), upstream redirects are never followed, TLS verification cannot be disabled, and failures answer flat errors: `502 bad_gateway` unreachable, `504 gateway_timeout` on the `timeoutMs` deadline (default 30s). `stripPrefix` and static override `headers` are supported. WebSocket upgrade is not proxied.

### Patch Changes

- e80b743: `stripPrefix` now only strips on a path-segment boundary. `stripPrefix: "/api"` matched `/apikeys` as
  well as `/api/...` and forwarded it upstream as `/keys`, which is a different route than the caller
  asked for - and, where the prefix marks a trust boundary, a route on the other side of it. A path must
  now equal the prefix or continue with `/`.
