# @nifrajs/proxy

## 3.3.0

## 3.2.0

### Patch Changes

- 7551709: Harden runtime boundaries and defaults: clean up subprocess abort listeners, support short Cloudflare
  KV sessions, bound and incrementally sweep the default memory cache, make image reads and cancellation
  safe, emit content-derived image validators, require trusted forwarded hosts, avoid caching dynamic SSR
  metadata, and reject invalid upload or image limits.

## 3.1.0

### Patch Changes

- 5b78473: The post-cancel request-body drain is now capped at 8 MiB. Once an early response (such as a `413`) has left, an over-cap trickle is discarded at the ceiling rather than holding the connection open.

## 3.0.0

### Minor Changes

- f0fd370: The portable transport is exported as `fetchTransport()`, and it now bounds a stalled response body the way the undici one does.

  `timeoutMs` covers the wait for response headers - the only window in which a 504 is still sendable - and the undici transport has always taken a `bodyTimeoutMs` for what happens after. The `fetch()` transport had no such bound, so an upstream that sent its headers and then went silent held the relay open for as long as it liked, one request and one upstream connection per stalled body. It now errors the relayed stream and cancels the upstream read after the same 30s of silence between chunks, so the choice of transport no longer changes the bound:

  ```ts
  import { createProxy, fetchTransport } from "@nifrajs/proxy";

  const proxy = createProxy({
    upstream: "http://127.0.0.1:8081",
    transport: fetchTransport({ bodyTimeoutMs: 5_000 }),
  });
  ```

  The timer is armed per read and disarmed as soon as a chunk arrives, so a slow-but-progressing body is never interrupted; `0` disables it, and a negative or non-finite value throws at construction. The default transport is unchanged in behaviour beyond the new bound, and picking it explicitly costs nothing - `createProxy` without a `transport` still builds one instance, not one per request.

  An `AbortSignal` passed in by the caller no longer accumulates a listener per proxied request. `createProxy` subscribes to it to tear the upstream hop down on a client disconnect, and for the common case - the request's own signal - that subscription dies with the request. A signal shared across many requests, such as a server-lifetime shutdown signal, kept every one of those listeners for as long as it lived. The subscription is now released when the response settles: on the error path, on a body-less response, and when the relayed body ends, errors, or is cancelled. A body relayed to a Node adapter still hands over its underlying stream, so the fast path is unaffected.

- 5ef172f: `createProxy` now takes an optional `transport`, and a new `@nifrajs/proxy/undici` subpath ships one for Node.

  The upstream hop was hardwired to `fetch()`. That is the portable choice and stays the default, but on Node it is a spec-compliant wrapper over undici, and the wrapper is most of the cost of a proxied request: measured against a local origin at 50 connections, going straight to undici's dispatcher instead is roughly 2.5x the throughput on GET and 2.2x on POST in isolation, and about 1.4x end to end through a nifra server. On Bun there is no such gap, so the default is already the fast path there.

  ```ts
  import { createProxy } from "@nifrajs/proxy";
  import { undiciTransport } from "@nifrajs/proxy/undici";

  const proxy = createProxy({
    upstream: "http://127.0.0.1:8081",
    transport: undiciTransport(),
  });
  ```

  `undici` is an optional peer dependency - the base package stays dependency-free for anyone who does not opt in - and `undiciTransport()` throws at construction under Bun rather than degrading silently, since the `undici` specifier resolves to a built-in shim there.

  A transport is a security boundary, and the exported `ProxyTransport` type documents the obligations: dial exactly the URL handed over, do not follow redirects, leave TLS verification on, and forward the already-sanitised headers unchanged. The supplied undici transport meets all four; the one a caller can break is redirects, since a `dispatcher` passed to it could compose a redirect interceptor. Header hygiene, the deadline, and forwarding-metadata suppression all still run in `createProxy` itself, on either transport.

  `timeoutMs` is now documented as covering the wait for response headers only - the window in which a `504` is still sendable. A body that starts and then stalls is the transport's concern; `undiciTransport()` takes a `bodyTimeoutMs` (default 30s) for it. A caller disconnect still tears the upstream request down at any point.

  `undiciTransport()` also accepts a `dispatcher`, so connections per origin can be tuned with an undici `Agent` or `Pool`.

- 843a308: `createProxy` uses the undici transport by default on Node, and relays a compressed upstream response with its encoding intact.

  When no `transport` is given, the proxy now selects the faster undici upstream path on Node whenever `undici` is installed, resolving it lazily so the base package keeps no static dependency on `undici`. Every other runtime (and a Node install without the optional `undici` peer) keeps the portable `fetch` transport. Pass a `transport` explicitly to pin the choice or tune it.

  Because undici does not decode `Content-Encoding` the way `fetch` does, a compressed upstream response is now relayed with its `content-encoding` and `content-length` preserved, and the client decodes the bytes it receives - matching how a Node-native reverse proxy passes bytes through, and saving the proxy the decode. A transport that does not decode signals this through the new optional `ProxyUpstreamResponse.bodyEncoded` field; when it is unset (the `fetch` transport, and existing custom transports) the previous strip-and-relay-identity behaviour is unchanged.

### Patch Changes

- 0b84557: Proxying on Node no longer repackages request and response bodies through Web streams when both sides of the hop are Node-native.

  `@nifrajs/node` receives a Node `IncomingMessage` and must present a Web `Request`; `@nifrajs/proxy/undici` receives that `Request` and must hand undici a Node stream again. Nothing observable came of that round trip, but it was the bulk of the remaining distance to `@fastify/reply-from`, which never leaves Node streams. Measured on a pinned-core Linux rig against a local origin at 50 connections, as a share of what the origin serves unproxied: GET went from 22.3% to 25.7% (fastify 24.1%) and POST from 21.0% to 26.4% (fastify 26.8%).

  Nothing changes for callers. The Web view is still a real `ReadableStream` and is what any other consumer gets; the hand-off happens only when the receiving layer is going to write those bytes to a Node stream anyway, and only while the Web view is untouched. A body that has been read, is held by a reader, or has already been handed over takes the ordinary conversion instead, so a body can never be split between the two views.

  Also fixed on the way: an upstream body destroyed for a client that disconnected mid-request could raise an unhandled stream error and terminate the process.

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
