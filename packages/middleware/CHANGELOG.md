# @nifrajs/middleware

## 3.1.0

### Patch Changes

- 1400f6c: Portable response header, body, and raw-response observation is now enabled explicitly with `responseObserver()` from `@nifrajs/core/response-observer`. Official middleware that uses these tiers remains compatible and enables the runtime automatically.
  - @nifrajs/schema@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [f0fd370]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0
  - @nifrajs/schema@3.0.0

## 2.14.1

### Patch Changes

- @nifrajs/schema@2.14.1

## 2.14.0

### Patch Changes

- @nifrajs/schema@2.14.0

## 2.13.0

### Patch Changes

- e0b2dd6: Harden three regex-adjacent input paths against pathological input. The byte-range parser bounds an
  oversized `Range` header before the matcher runs rather than after; the problem-details type builder
  strips trailing slashes with a linear scan instead of a backtracking pattern; and the dev SSR
  import-graph specifier pattern no longer has an ambiguous whitespace group. Behavior is unchanged for
  valid input.
  - @nifrajs/schema@2.13.0

## 2.12.1

### Patch Changes

- @nifrajs/schema@2.12.1

## 2.12.0

### Minor Changes

- 0fd146f: The default idempotency store key is now scoped by a digest of the caller's credential headers as
  well as by method + path. Presenting another caller's `Idempotency-Key` used to address their stored
  entry and replay their response; it now addresses a different key entirely. The headers that identify
  a caller are configurable via `principalHeaders` (default: Authorization, Cookie, x-api-key), and only
  a SHA-256 digest ever becomes part of a key - a raw credential as a store key would show up in every
  Redis `KEYS` dump and slow-log line. A custom `key` still replaces the scoping wholesale and must fold
  in the principal itself; it may now be async.

  `MemoryIdempotencyStore` is bounded: `maxEntries` (default 10,000) and `maxKeyBytes` (default 1024).
  Reaching the cap refuses rather than evicts - every entry is a live lock or a response someone is
  entitled to replay, so evicting to make room is how a duplicate charge happens - and the middleware
  answers `503 idempotency_unavailable` with `retry-after`. Expired entries are swept incrementally, so
  a normal request never walks the map.

- 9a9346e: `app.use(plugin)` keeps the caller's server type. A plugin built with `definePlugin` whose input
  server type is not pinned used to widen the app to `Server<any, any>`, so every route declared
  before _and_ after the `use` lost its types and the typed client silently degraded to `any`. That
  case is now a compile error at the `use` call site, naming the definer to switch to; the plugin is
  unchanged at runtime.

  Pick the definer that matches what the plugin does: `defineContextPlugin<D>` when it adds context
  via `derive`/`decorate` (the registry threads through and `D` is added to every downstream handler
  context), `defineRouterPlugin` when it mounts routes/hooks and adds no context (mount as a side
  effect, return the app). `definePlugin` still works when its input type is pinned - annotate the
  parameter (`(app: typeof api) => ...`) or pass explicit type arguments.

  Every first-party plugin now threads: `jwt`, `tokenAuth`, `basicAuth`, `durableCommand`, `etag`,
  `compression`, `problemDetails`, `prettyJson`, `methodOverride`, `trailingSlash`, `cacheControl`,
  `devtools`, and `metrics` return an `IdentityPlugin`; `timing`, `language`, and `tracing` return a
  `ContextPlugin` of what they add (`{ timing }`, `{ language, languageMatch }`, and
  `{ trace, observation, causality }` respectively), so `c.timing` / `c.language` / `c.trace` are
  typed without a manual annotation. `combine(...)` is typed as an identity bundle and
  `namedCombine(name, ...)` is its deduped, named form.

  A type-level test asserts the threading for each definer shape, so a regression fails `typecheck`
  rather than surfacing as `any` in a downstream app.

- 59e547b: `securityHeaders` gains opt-in cross-origin isolation knobs: `crossOriginOpenerPolicy`, `crossOriginEmbedderPolicy`, `crossOriginResourcePolicy`, and `permissionsPolicy`. All remain off by default and are declared as static response headers, so the fused native lanes are preserved.
- dbc0b79: Signing-secret rotation. `signValue`/`unsignValue` (and the new `CookieSecret` type), session `secret`, and CSRF `secret` now also accept a rotation list: the first secret signs, any listed secret verifies, so keys rotate without invalidating live cookies, sessions, or CSRF tokens. Every listed secret must meet the 32-byte floor and an empty list throws; the single-secret path is unchanged.

### Patch Changes

- eb3602b: `cache()` no longer serves a stored entry to a credentialed request. The write side already refused to
  store a personalized response, but a request carrying credentials could still be answered from an
  entry stored earlier by an anonymous caller, before the route's own authentication ran. Reads now
  apply the same test as writes: a request carrying a credential header only reads an entry whose own
  `Cache-Control` marks it public (`public` or `s-maxage`). The credential headers are configurable via
  `authenticatedHeaders` and now include `x-api-key` alongside Authorization and Cookie. Routes with
  `cacheAuthenticated: true` are unaffected.
- 70ebad4: `jwt()` now verifies that a `CryptoKey` passed as the verification key actually matches the algorithm
  being verified. A key imported for one algorithm was previously used as-is for whichever `alg` the
  configuration named, so an HMAC secret could be handed to an RS256 verification (and vice versa),
  turning the algorithm choice into something the key no longer pins down. The key's `type`,
  `algorithm.name`, `algorithm.hash`, and `verify` usage must all line up, or the token is rejected with
  a JWT error. Raw string and `Uint8Array` secrets are imported by the middleware itself and were
  already bound.
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

- Updated dependencies [9a9346e]
  - @nifrajs/schema@2.12.0

## 2.11.0

### Patch Changes

- @nifrajs/schema@2.11.0

## 2.10.0

### Minor Changes

- 15bffdd: Add opt-in RFC 9457 Problem Details responses for Nifra framework errors while preserving the default error envelope.
- 15bffdd: Add standards-shaped range, conditional, content-negotiation, and multipart response helpers, plus public token-only data contracts and typed in-memory channel seams.

### Patch Changes

- @nifrajs/schema@2.10.0

## 2.9.1

### Patch Changes

- @nifrajs/schema@2.9.1

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

### Patch Changes

- Updated dependencies [b006d07]
  - @nifrajs/schema@2.9.0

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.
  - @nifrajs/schema@2.8.2

## 2.8.1

### Patch Changes

- @nifrajs/schema@2.8.1

## 2.8.0

### Patch Changes

- @nifrajs/schema@2.8.0

## 2.7.1

### Patch Changes

- @nifrajs/schema@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/schema@2.7.0

## 2.6.1

### Patch Changes

- @nifrajs/schema@2.6.1

## 2.6.0

### Patch Changes

- @nifrajs/schema@2.6.0

## 2.5.0

### Patch Changes

- @nifrajs/schema@2.5.0

## 2.4.0

### Patch Changes

- @nifrajs/schema@2.4.0

## 2.3.0

### Minor Changes

- 8514caa: A capability requiring durable idempotency has an adapter that satisfies it.

  ```ts
  import { createDurableEffectJournal } from "@nifrajs/core/durable-execution";
  import { durableCommand } from "@nifrajs/middleware";

  const app = server()
    .use(durableCommand({ journal: createDurableEffectJournal({ store }) }))
    .post("/charge", { capabilities: ["billing.charge"] }, (c) =>
      executeCapability(c, "billing.charge", {}, () => gateway.charge(order))
    );
  ```

  A capability defined `idempotency: "durable"` requires `nifra.durable-command` evidence, and nothing
  shipped produced it. The tier was reachable, but only by writing `assurance: ["nifra.durable-command"]`
  on the route - an assertion with nothing behind it, and wrong in both directions: a route that
  genuinely journals its effects but omits the string fails `nifra check`, and a route that journals
  nothing but includes it passes. Every other assurance id has a shipped emitter; this one now does too.

  The evidence is a by-product rather than a claim. Installing the adapter puts the journal on the
  request, so `executeCapability` records intent before an effect runs and exactly one terminal outcome
  after - which is what the tier is asking about. `executeCapability` resolves an explicitly passed
  `journal` first, so existing call sites are untouched, and a journal missing a transition is refused at
  wiring time rather than surfacing as a TypeError partway through a production effect.

  `attachCapabilityJournal` and `capabilityJournalOf` are exported from `@nifrajs/core/capabilities` as
  the seam the adapter uses.

  Response replay is still not durable-command evidence, and that is deliberate: if the process dies
  between the effect and storing its response there is nothing to replay, so replay cannot be what makes
  an effect exactly-once. The journal survives that; only the journal clears the tier.

### Patch Changes

- @nifrajs/schema@2.3.0

## 2.2.0

### Patch Changes

- b5f89f8: `prettyJson` no longer hangs a client on an oversized streamed JSON response.

  The middleware peeked at the body through `Response.clone()` and cancelled the clone's reader once the
  byte cap was exceeded. In Bun that cancel also stalls the original body, so a JSON response with no
  `content-length` and more than `maxBytes` of payload was passed through as a body that never completes.
  A response that should simply have skipped pretty-printing instead never finished.

  Only the cancel does this - a clone read to completion is fine - which is why every buffered response
  worked and only a streamed one failed.

  The body is now read directly and, when it proves too large, replayed: the bytes already pulled are
  re-emitted ahead of the rest of the same reader, and cancelling that stream cancels upstream. Nothing is
  buffered past the cap, and the client receives byte-for-byte what the handler produced.

  - @nifrajs/schema@2.2.0

## 2.1.0

### Patch Changes

- @nifrajs/schema@2.1.0

## 2.0.0

### Major Changes

- d91a45b: Remove Nifra's remaining deprecated and compatibility-only public surfaces for the 2.0 cutover.

  - `@nifrajs/core` and `nifra` now expose only the lean HTTP server API at their package roots. Import
    optional systems from their documented subpaths. The deprecated invariant runner and the
    `@nifrajs/budget` compatibility package are removed; use `@nifrajs/testing` and
    `@nifrajs/core/budget` respectively.
  - Web redirects accept only an options object as their second argument, the prerender enumeration
    wrapper is removed in favor of `enumerateStaticRoutes()`, and fragment navigation resolves IDs only.
  - MCP Apps metadata uses only `_meta.ui.resourceUri`; the deprecated flat `ui/resourceUri` key is gone.
  - Telemetry uses `ObservationAdapter` directly; the `AgentSpan`, `AgentSpanExporter`, and `SpanExporter`
    aliases are removed.
  - Invalid HTTP method overrides always fail closed with 400; the legacy ignore mode is removed.
  - `nifra build` always emits a complete target deploy directory and defaults to Bun. The old
    client-only build branch is removed; `nifra start` runs the generated Bun `server.js`.

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0
  - @nifrajs/schema@2.0.0

## 1.13.0

### Patch Changes

- @nifrajs/schema@1.13.0

## 1.12.0

### Patch Changes

- @nifrajs/schema@1.12.0

## 1.11.0

### Patch Changes

- 2dde7e5: Documentation polish for the adaptive-admission module.
  - @nifrajs/schema@1.11.0

## 1.10.0

### Patch Changes

- 92181be: Move request-deadline mechanics to the dependency-free `@nifrajs/core/budget` subpath while keeping
  `@nifrajs/budget` as a compatible re-export. Harden adaptive admission across ESM runtimes, reserved
  capacity, disconnected queued requests, and invalid capacity evidence.
  - @nifrajs/schema@1.10.0

## 1.9.1

### Patch Changes

- @nifrajs/schema@1.9.1

## 1.9.0

### Patch Changes

- @nifrajs/schema@1.9.0

## 1.8.0

### Minor Changes

- e47c4c5: Add reflection-time route assurance: middleware and plugins can publish lifecycle-accurate enforcement
  evidence, ordered policies fail closed on unclassified/missing/forbidden evidence, official hardening
  middleware emits canonical evidence, and `nifra assure` exposes a human/JSON CI gate.

### Patch Changes

- @nifrajs/schema@1.8.0

## 1.7.0

### Patch Changes

- @nifrajs/schema@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/schema@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [bd3433f]
  - @nifrajs/schema@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/schema@1.4.0

## 1.3.1

### Patch Changes

- @nifrajs/schema@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [4a4b1c4]
  - @nifrajs/schema@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/schema@1.2.2

## 1.2.1

### Patch Changes

- @nifrajs/schema@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/schema@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [17e57c4]
  - @nifrajs/schema@1.1.0

## 1.0.0

### Minor Changes

- de9675b: Pre-1.0 security hardening pass. A framework-wide audit found no critical/high issues; these close the medium/low items it surfaced.

  - **`cache()` - no cross-user leak by default.** A `200` to a request bearing `Authorization`/`Cookie` is no longer stored (and replayed to other users) unless the response is explicitly `Cache-Control: public`/`s-maxage` (RFC 9111 §3.5). Opt back in per cache with `cacheAuthenticated: true` for a route that's identical for every caller.
  - **`idempotency()` - route-scoped keys + a `key` hook.** The default store key is now scoped by method+path, so the same `Idempotency-Key` on a different endpoint can't collide and replay another resource's response. Added a `key(req, header)` option to scope by principal (e.g. user id). Method matching normalized to upper-case.
  - **`etag()` - a `304` no longer carries the `200`'s `Content-Length`/`Content-Type`.**
  - **`@nifrajs/core` - inbound WebSocket frames are capped** when serving on Bun (`listen()`): frames over `wsMaxPayloadBytes` (default `maxBodyBytes`, 1 MB) are rejected by the runtime before reaching a handler, so a huge frame can't be buffered/parsed into memory. New `ServerOptions.wsMaxPayloadBytes`.
  - **`@nifrajs/core` - WebSocket routes are same-origin by default (CSWSH).** A `ws()` route with no `allowedOrigins` now rejects a **cross-origin browser** handshake (an `Origin` whose host differs from the request's) with `403` - closing cross-site WebSocket hijacking, since browsers send cookies on WS handshakes and don't apply CORS. Non-browser clients (no `Origin`) and same-origin browsers are unaffected. **Breaking** for a route that served a cross-origin browser without declaring `allowedOrigins`: set `allowedOrigins` to the permitted origins (or `() => true` for a genuinely public socket).
  - **`@nifrajs/node` - static file handler** now adds `X-Content-Type-Options: nosniff` and re-checks the real path (symlink containment) before streaming, matching the image server.
  - **`@nifrajs/mcp` - widget bridge** now rejects `postMessage` events whose source isn't the parent window (including null-source synthetic events), closing a spoofing gap the previous guard left open.
  - **`@nifrajs/cli` - the MCP `nifra_run`/`nifra_ws` `entry` arg** is kept inside the project root, so a crafted `entry` can't import/execute a module outside the project.

### Patch Changes

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/core@1.0.0
  - @nifrajs/schema@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/core@1.0.0-beta.4
- @nifrajs/schema@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/core@1.0.0-beta.3
- @nifrajs/schema@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- @nifrajs/core@0.1.0-beta.2
- @nifrajs/schema@0.1.0-beta.2
