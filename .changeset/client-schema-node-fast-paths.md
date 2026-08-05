---
"@nifrajs/client": patch
"@nifrajs/schema": patch
"@nifrajs/middleware": patch
"@nifrajs/node": patch
---

Faster typed client, validation, and Node serving without touching any contract:

- `@nifrajs/client`: in-process clients (`inProcessClient`/`testClient`) read same-process response
  bodies through the native path while still enforcing the same byte cap (identical error), reuse
  shared codec registries and retry/signal defaults instead of rebuilding them per call, and memoize
  static route-proxy segments - a typed in-process call is measured ~7x faster end to end.
- `@nifrajs/schema`: `coerce` validation replays a per-schema conversion plan for flat scalar
  objects (the shape of real query schemas) instead of an interpretive schema walk per request,
  with property-test-pinned parity. Also fixes a correctness bug: a schema carrying a backslash in
  a property key or string literal now validates correctly (such schemas take the eval-free
  checker, where previously the compiled checker could silently reject valid input).
- `@nifrajs/middleware`: `cors`, `securityHeaders`, `poweredBy`, static `cacheControl`,
  `rateLimit` (with the built-in key derivation), `logger`, and `language` now ship header-only
  native hooks so Node serving can apply them on the direct writer without materializing Web
  request/response objects; the cookie parser is shared with core. Stateful pairs (`rateLimit`,
  `logger`) carry per-request state on the native context's stable identity, and `language`
  recomputes its match from the request header on both paths (its `Content-Language` now also
  covers unrouted responses).
- `@nifrajs/node`: response headers are written with a single native `setHeaders` call (repeated
  `Set-Cookie` values stay un-joined), a hook-supplied `Content-Type` is preserved on buffered JSON
  writes, `Content-Length` is always declared for buffered bodies so responses never fall back to
  chunked framing, and the per-response header normalization copy is skipped when every name is
  already lowercase (the common case - wire output is unchanged).
