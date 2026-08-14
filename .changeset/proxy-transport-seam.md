---
"@nifrajs/proxy": minor
---

`createProxy` now takes an optional `transport`, and a new `@nifrajs/proxy/undici` subpath ships one for Node.

The upstream hop was hardwired to `fetch()`. That is the portable choice and stays the default, but on Node it is a spec-compliant wrapper over undici, and the wrapper is most of the cost of a proxied request: measured against a local origin at 50 connections, going straight to undici's dispatcher instead is roughly 2.5x the throughput on GET and 2.2x on POST in isolation, and about 1.4x end to end through a nifra server. On Bun there is no such gap, so the default is already the fast path there.

```ts
import { createProxy } from "@nifrajs/proxy"
import { undiciTransport } from "@nifrajs/proxy/undici"

const proxy = createProxy({ upstream: "http://127.0.0.1:8081", transport: undiciTransport() })
```

`undici` is an optional peer dependency - the base package stays dependency-free for anyone who does not opt in - and `undiciTransport()` throws at construction under Bun rather than degrading silently, since the `undici` specifier resolves to a built-in shim there.

A transport is a security boundary, and the exported `ProxyTransport` type documents the obligations: dial exactly the URL handed over, do not follow redirects, leave TLS verification on, and forward the already-sanitised headers unchanged. The supplied undici transport meets all four; the one a caller can break is redirects, since a `dispatcher` passed to it could compose a redirect interceptor. Header hygiene, the deadline, and forwarding-metadata suppression all still run in `createProxy` itself, on either transport.

`timeoutMs` is now documented as covering the wait for response headers only - the window in which a `504` is still sendable. A body that starts and then stalls is the transport's concern; `undiciTransport()` takes a `bodyTimeoutMs` (default 30s) for it. A caller disconnect still tears the upstream request down at any point.

`undiciTransport()` also accepts a `dispatcher`, so connections per origin can be tuned with an undici `Agent` or `Pool`.
