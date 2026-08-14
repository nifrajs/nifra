# @nifrajs/node

## 2.13.0

### Patch Changes

- 7535ce1: A direct body read on Node - `c.req.json()`, `c.req.text()`, `c.req.arrayBuffer()`, `c.req.bytes()`
  on a raw-body route - now reads straight off the socket instead of first building the Web `Request`
  the adapter had been deferring. The body cap is unchanged and still enforced by the same bounded
  reader: an over-cap `Content-Length` is rejected before buffering, a chunked body is still aborted
  mid-stream rather than buffered first, `clone()` inherits the cap, and `c.boundedBody(explicit)`
  still overrides it in either direction. `c.req` keeps its identity and every other member behaves
  as before. Net: a raw-body `POST` that reads through `c.req` gets a large throughput gain - roughly
  +65% on the JSON-body workload in the Bun HTTP framework benchmark on Node - and is no longer the
  slowest lane in a nifra app.
- 9ee466e: Add an opt-in `serve({ fastResponse: true })`. With it on, a handler that returns a hand-rolled
  `new Response(body)` with a string body rides the same direct-write lane `c.text` / `c.json` already
  use: the reply reaches the socket from a status, a header record, and the bytes, instead of the
  adapter draining a `Response` body stream. It works by swapping `globalThis.Response` for a stand-in
  that defers a _simple_ construction (a string body, no `statusText`, and no headers or a plain header
  record) and builds a real `Response` for anything else (a stream, a `Blob`, `null`, a `Headers`
  instance) unchanged. A simple response is byte-identical to before, including the `content-type` the
  native constructor infers, and stays `instanceof Response`.

  Off by default: `c.text` / `c.json` get the fast lane without any global change, so prefer them.
  Reach for `fastResponse` only when handlers build `Response` by hand on a hot path - it patches a
  process-global builtin, so every `new Response(...)` in the process goes through the stand-in.

- 1704308: On Node, `c.text(...)` and `c.json(...)` now defer building the Web `Response`. The adapter writes a
  text or JSON body to the socket from a status, a header record, and the bytes directly, so the
  `Response` those helpers used to construct up front - about a quarter of the request budget on a
  small response - is built only if something actually reads the Web surface (a response hook,
  `app.fetch`, or user code touching `.headers`), and forwarded to from then on. The returned value is
  still a real `Response`: `instanceof Response` holds, the status, headers, and body are unchanged,
  and the content-type is byte-identical to what the eager `Response` carried. Bun and Deno, which hand
  the `Response` to their native server, are unaffected. Net: a plain text or JSON return on Node lands
  on the adapter's fastest write lane - on the Bun HTTP framework benchmark the text workloads (Ping,
  Query) go from roughly 0.75x of Fastify to level with it, and clear of Hono.

## 2.12.1

## 2.12.0

### Minor Changes

- 0a91064: Two new `serve()` options decide the authority in `request.url`. `allowedHosts` takes a list or a
  predicate and answers `400` before the app runs when the inbound `Host` is not one of them;
  `canonicalHost` builds every request URL from one fixed authority and ignores the inbound value, the
  right setting behind a proxy that already validates. Both parse the header properly: the port is
  range-checked, the bracketed IPv6 form is handled, and anything carrying CR/LF, whitespace, or
  userinfo is rejected.

  The check runs at request entry, so the lean GET path that builds its URL lazily is covered too.
  With neither option set, behavior is unchanged and the host in `request.url` remains
  client-controlled - the README now says so, along with the public-only contract for the `static`
  root.

- df18a93: The static file server denies dotfiles by default. A request whose path contains a dot-leading
  segment (`/.env`, `/.git/config`, `/.hidden/app.js`) - including `%2E`-encoded spellings - answers
  `404` with the same body as a missing file, so probing cannot distinguish "hidden" from "absent".
  Dotfiles land in build output by accident (`.env` next to the bundle, a copied `.git` tree), so
  serving them is opt-in: set the new `dotfiles: "allow"` option when the directory deliberately
  contains them (e.g. `/.well-known`). Filenames that merely contain dots (`logo..png`) are
  unaffected; the check rides the existing traversal pass, adding no filesystem access and no
  per-request cost on clean paths.

### Patch Changes

- ae5338f: Cut per-request overhead on the JSON body lane and the Node adapter.

  The bounded JSON reader now returns the body read's own promise instead of running as an async
  function, so a framed JSON POST pays one microtask hop rather than several. The prototype-poisoning
  walk checks the suspect keys during the single enumeration it already performs instead of probing
  each node twice. The Node adapter memoizes Host-authority normalization, which repeats for every
  request of a deployment.

  No behaviour change: the same bodies are accepted, the same poisoning shapes are rejected or
  stripped, and the same Host values normalize to the same authority.

- 5e4e31a: The Node-direct response path asks "are these header names already the lowercase wire spelling"
  once per request instead of three times. Core answers it where the answer is already in hand - the
  static-header fold derives each name's lowercase form anyway, and the native response walk was
  walking the same keys - and publishes it as a symbol-keyed mark the header view and `@nifrajs/node`'s
  direct writer read instead of re-scanning. An app that registers a raw `onNodeResponse` twin (one
  handed the record itself rather than the case-normalizing view) is never marked and keeps the
  per-reader scans, since such a twin writes after the point the mark would be set. Wire output is
  unchanged by construction: it is the same answer, from the same pass.

  Header-normalization frames fall from 4.1% to 1.5% of self time on a middleware-heavy route and from
  1.6% to 0.6% on a hookless one (V8 CPU profile, `GET /users/:id`). `@nifrajs/middleware`'s Node
  response twins set one header at a time through a helper that keeps the record in V8's fast property
  mode rather than re-homing it into a null-prototype object, which demoted every later lookup on the
  response path to dictionary mode.

- f8b0097: A `.ws()` route's `maxPayloadBytes` is now enforced on every runtime, not only the ones whose socket
  implementation happened to police it. The declared cap travels with the upgrade outcome, so the Node
  bridge hands it to `ws` as `maxPayload`, and the Deno and Workers/`attachWebSocket` message paths
  measure the frame and close with `1009 message too large` instead of delivering it. A route that
  declares no cap is untouched and pays nothing: sizing a text frame costs a UTF-8 encode, so the
  measurement only runs where a cap exists.

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

### Minor Changes

- b006d07: Faster typed client, validation, and Node serving:

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
    All three now ALSO handle raw responses through the new raw tier: `compression` gzips streamed
    and proxied responses (buffering up to its threshold peek, honoring `Accept-Encoding` q-values so
    `gzip;q=0` is respected), `etag` hashes and can `304` raw buffered bodies up to a size cap, and
    `prettyJson` re-indents raw JSON bodies - while framework-serialized payloads stay on the payload
    tier and Node's direct writer. `prettyJson`'s `enabled` predicate receives the portable request
    view (`{ method, url, header(name) }`) instead of a `Request`.
  - `@nifrajs/node`: response headers are written with a single native `setHeaders` call (repeated
    `Set-Cookie` values stay un-joined), a hook-supplied `Content-Type` is preserved on buffered JSON
    writes, `Content-Length` is always declared for buffered bodies so responses never fall back to
    chunked framing, and the per-response header normalization copy is skipped when every name is
    already lowercase (the common case - wire output is unchanged). `serve()` also activates Node's
    async-context tracking before listening: activation is otherwise triggered lazily by the first
    connection teardown, after V8 has optimized the event-loop tick path against the inactive
    bookkeeping, and that mid-traffic switch costs about 11% of per-request CPU for the life of the
    process on Node 24+. When a full `onResponse` hook
    forces the Web path, the buffered outcome is now bridged through a lazy spec-shaped Response
    (srvx's `FastResponse`, a real `instanceof Response` via prototype chaining) that materializes
    headers and body machinery only when a hook touches them - measured ~20% more throughput on that
    path. Building a Web `Request` also fills its header list once from a plain record instead of
    copying a prebuilt `Headers` twice.

## 2.8.2

## 2.8.1

### Patch Changes

- 78d66a4: Node serving got measurably faster - ahead of Fastify on every workload in our benchmark, where it previously trailed by ~2%. Three changes, all behavior-preserving:

  - Buffered responses (node-direct JSON and SSR body outcomes) now declare `Content-Length` instead of falling back to `Transfer-Encoding: chunked` - a known-length body never needed chunked framing, which cost extra wire bytes and client parsing on every response, and no other runtime chunked these.
  - The socket-peer platform object is built once per connection and reused across keep-alive requests (the peer address cannot change mid-socket).
  - Routing on Node now splits pathname/search straight from the origin-form request target; the absolute URL is only synthesized if something actually reads `c.req.url`. `RequestSource` gained an optional `urlParts` field for sources that already hold the split target.
  - An absent-header probe no longer falls through to the source's `Headers` object: a source-implemented `header()` returning `null` is authoritative. The fallthrough was materializing a full `Headers` on every POST (the body lane's `transfer-encoding` check), measured at ~4% of request CPU - the POST lane on Node is ~9% faster without it.

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

### Patch Changes

- 5840c98: Two hot-path costs removed. On Bun, the socket peer address is now resolved lazily: `c.clientIp` keeps its documented raw-peer behavior, but the underlying `requestIP()` lookup (surprisingly expensive per request) only runs when something actually reads it - trust-mode routes still resolve it before the handler. On Node, buffered SSR responses no longer clone the response-header record (and every Set-Cookie array) before `writeHead` - the producer already hands over response-normalized names and values.

## 2.6.0

### Patch Changes

- e6349e5: Security hardening across input parsing and code generation. Every regex that runs on caller-influenced input (URL paths, route patterns, stylesheet and SVG sources, manifest text) is now linear - no polynomial backtracking on adversarial input. SVG preamble stripping and tag removal can no longer splice removed delimiters into new markers. Static file serving rejects `..` traversal in the request form outright and confines the resolved path with a `relative()` containment check. Generated code embeds strings through an escaper that neutralizes `</script>` breakout and the U+2028/U+2029 line separators, and HTML entity decoding resolves `&amp;` last so double-encoded entities cannot double-unescape.
- 994a944: `serve` no longer passes an explicit `undefined` hostname to `http.Server.listen`. Node accepts that overload, but Bun's Node-compatible server can misinterpret it (especially with `port: 0`) as a failed bind; omitting the argument selects the same default host with an unambiguous overload.

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

### Minor Changes

- a7b1d60: Add `c.clientIp` - the caller's IP, derived correctly and vendor-neutrally.

  By default it is the raw socket peer the serving adapter observed (`listen()`, `@nifrajs/node`, `@nifrajs/deno` supply it; any caller can pass it via `app.fetch(req, { clientIp })`), the one address a client cannot forge - and never a forwarded header. Behind a reverse proxy or CDN, set the `clientIp` server option to derive the real caller from the forwarding chain as far as you trust it:

  - `server({ clientIp: { trustedHops: n } })` reads `X-Forwarded-For` past `n` proxies you operate (a short header fails closed to `undefined`);
  - `server({ clientIp: { header: "x-real-ip" } })` trusts one edge-set header's first value.

  Declaring trust the app can't enforce would let clients forge their IP, so it stays unset by default. `c.clientIp` is safe to key rate limits and audit logs on, and is resolved once before handlers, `derive`, and hooks run.

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

### Minor Changes

- 0ac2182: perf(node): lean request source for GET/HEAD

  GET/HEAD requests (the bulk of API traffic) now use a smaller request-source object in the Node
  adapter: no body plumbing is allocated (GET/HEAD carry none, per the fetch spec - `body` is `null`,
  `boundedBody()` resolves empty), while headers and the full Web `Request` stay lazily available if
  read. Body-capable methods keep the existing lazy source. No behavior change.

## 1.1.0

## 1.0.0

### Patch Changes

- de9675b: Pre-1.0 security hardening pass. A framework-wide audit found no critical/high issues; these close the medium/low items it surfaced.

  - **`cache()` - no cross-user leak by default.** A `200` to a request bearing `Authorization`/`Cookie` is no longer stored (and replayed to other users) unless the response is explicitly `Cache-Control: public`/`s-maxage` (RFC 9111 §3.5). Opt back in per cache with `cacheAuthenticated: true` for a route that's identical for every caller.
  - **`idempotency()` - route-scoped keys + a `key` hook.** The default store key is now scoped by method+path, so the same `Idempotency-Key` on a different endpoint can't collide and replay another resource's response. Added a `key(req, header)` option to scope by principal (e.g. user id). Method matching normalized to upper-case.
  - **`etag()` - a `304` no longer carries the `200`'s `Content-Length`/`Content-Type`.**
  - **`@nifrajs/core` - inbound WebSocket frames are capped** when serving on Bun (`listen()`): frames over `wsMaxPayloadBytes` (default `maxBodyBytes`, 1 MB) are rejected by the runtime before reaching a handler, so a huge frame can't be buffered/parsed into memory. New `ServerOptions.wsMaxPayloadBytes`.
  - **`@nifrajs/core` - WebSocket routes are same-origin by default (CSWSH).** A `ws()` route with no `allowedOrigins` now rejects a **cross-origin browser** handshake (an `Origin` whose host differs from the request's) with `403` - closing cross-site WebSocket hijacking, since browsers send cookies on WS handshakes and don't apply CORS. Non-browser clients (no `Origin`) and same-origin browsers are unaffected. **Breaking** for a route that served a cross-origin browser without declaring `allowedOrigins`: set `allowedOrigins` to the permitted origins (or `() => true` for a genuinely public socket).
  - **`@nifrajs/node` - static file handler** now adds `X-Content-Type-Options: nosniff` and re-checks the real path (symlink containment) before streaming, matching the image server.
  - **`@nifrajs/mcp` - widget bridge** now rejects `postMessage` events whose source isn't the parent window (including null-source synthetic events), closing a spoofing gap the previous guard left open.
  - **`@nifrajs/cli` - the MCP `nifra_run`/`nifra_ws` `entry` arg** is kept inside the project root, so a crafted `entry` can't import/execute a module outside the project.

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2
