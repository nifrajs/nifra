---
"@nifrajs/client": patch
"@nifrajs/schema": patch
"@nifrajs/middleware": minor
"@nifrajs/node": minor
---

Faster typed client, validation, and Node serving:

- `@nifrajs/client`: in-process clients (`inProcessClient`/`testClient`) read same-process response
  bodies through the native path while still enforcing the same byte cap (identical error), reuse
  shared codec registries and retry/signal defaults instead of rebuilding them per call, and memoize
  static route-proxy segments - a typed in-process call is measured ~7x faster end to end.
- `@nifrajs/schema`: `coerce` validation replays a per-schema conversion plan for flat scalar
  objects (the shape of real query schemas) instead of an interpretive schema walk per request,
  with property-test-pinned parity. Also fixes a correctness bug: a schema carrying a backslash in
  a property key or string literal now validates correctly (such schemas take the eval-free
  checker, where previously the compiled checker could silently reject valid input).
- `@nifrajs/middleware`: header-only response middleware (`cors`, `securityHeaders`, `poweredBy`,
  static `cacheControl`, `language`) is rebuilt on the new portable `onResponseHeaders` hook - one
  implementation per middleware, applied on Node's direct writer and mutated in place on the Web
  paths (the previous clone-per-response is gone there too). `rateLimit` (with the built-in key
  derivation) and `logger` ship full native twins instead, carrying per-request state on the native
  context's stable identity; the cookie parser is shared with core. `language` now derives its
  match from the request header on every path, so its `Content-Language` also covers unrouted
  responses. `etag`, `prettyJson`, and `compression` move to the portable `onResponseBody` payload
  tier: they receive the final framework-serialized bytes on every runtime (nothing drained, the
  Node direct writer stays engaged, and compressed responses now carry a known `Content-Length`).
  Behavior notes: these three now apply to framework-serialized responses only - a handler-returned
  raw `Response` (a stream, a proxied fetch) passes through untouched - and `prettyJson`'s
  `enabled` predicate now receives the portable request view (`{ method, url, header(name) }`)
  instead of a `Request`.
- `@nifrajs/node`: response headers are written with a single native `setHeaders` call (repeated
  `Set-Cookie` values stay un-joined), a hook-supplied `Content-Type` is preserved on buffered JSON
  writes, `Content-Length` is always declared for buffered bodies so responses never fall back to
  chunked framing, and the per-response header normalization copy is skipped when every name is
  already lowercase (the common case - wire output is unchanged). When a full `onResponse` hook
  forces the Web path, the buffered outcome is now bridged through a lazy spec-shaped Response
  (srvx's `FastResponse`, a real `instanceof Response` via prototype chaining) that materializes
  headers and body machinery only when a hook touches them - measured ~20% more throughput on that
  path. Building a Web `Request` also fills its header list once from a plain record instead of
  copying a prebuilt `Headers` twice.
