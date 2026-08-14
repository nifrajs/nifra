# @nifrajs/core

## 2.14.1

### Patch Changes

- bf93902: The in-memory durable stores (`MemoryDurableEffectStore`, `MemoryApprovalStore`, `MemorySagaStore`) no longer perform a redundant deep clone when persisting a state transition. Stored records are already fresh and frozen, and reads still hand back isolated copies, so behaviour is unchanged while each transition allocates less.

## 2.14.0

### Minor Changes

- 701961a: New `raw<T>(response)` escape hatch keeps a hand-built `Response` inside the typed contract. A route
  that returns a bare `Response` - a Server-Sent Events stream, a file download, a signed token payload -
  previously inferred `res.data: never` on the client. Wrap the return as `raw<T>(response)` and the
  client sees `res.data` as `Jsonify<T>` while the route still ships the exact `Response` at runtime.
  Branded binary responses from `bytes()` keep their `Blob` typing; only an unbranded `Response` return
  falls back to `never`.
- 62133bf: Order-scoped hooks (`derive`, `decorate`, `beforeHandle`, `afterHandle`, `around`, `aroundCapability`,
  `onError`) are snapshotted into each route as it is declared, so one added after the last route was
  registered silently applies to nothing. This is the trap a route-registering factory sets: the app it
  returns has already declared its routes, so `app.use(requestId())` on it reaches zero of them.

  The server now detects this at seal - the first `listen()`, `fetch`, or `resolveNode` - and reports
  every order-scoped hook that covers no route, naming the hook kind and the call site so the fix (move
  it before the routes it should cover) is obvious. A previously-silent mistake now logs once at startup.

  New `unusedScopedHooks` server option: `"warn"` (default) logs the report, `"error"` throws a
  `FrameworkError` (`UNUSED_SCOPED_HOOKS`), `"off"` skips the check and its bookkeeping entirely. The
  report routes through a configured `logger`, else `console.warn`. Legitimate group scoping - a hook
  that intentionally covers only the routes declared after it - is never flagged, and app-global hooks
  (`onRequest`/`onResponse`/...) are unaffected because they are not order-scoped.

  The audit is a development-time diagnostic: it is guarded by `process.env.NODE_ENV !== "production"`, so
  any bundler that defines `NODE_ENV` strips it entirely from production builds - it adds zero bytes to
  the shipped bundle and zero per-request cost. It fires in development, test, and CI, where the mistake
  is caught, not in production.

- 8dffdf4: `.use(plugin)` no longer silently collapses the app's typed route registry to `any` when a plugin's own
  types are unpinned. A plugin whose parameter and return infer as `Server<any, any>` - an auth or router
  plugin that widened - now makes `.use()` return the non-callable `PluginTypeCollapsed` marker at the
  call site, rather than an `any` that only surfaces hundreds of lines away as `never`/`any` in the typed
  client. Build the plugin with `defineIdentityPlugin`/`defineContextPlugin`, or pin its input server
  type, and it threads the caller's registry and context unchanged.

  `serverFunctions()` now ships as such an identity plugin, so `app.use(serverFunctions(...))` keeps every
  route declared before and after it fully typed.

## 2.13.0

### Patch Changes

- e0b2dd6: Harden three regex-adjacent input paths against pathological input. The byte-range parser bounds an
  oversized `Range` header before the matcher runs rather than after; the problem-details type builder
  strips trailing slashes with a linear scan instead of a backtracking pattern; and the dev SSR
  import-graph specifier pattern no longer has an ambiguous whitespace group. Behavior is unchanged for
  valid input.
- 7535ce1: A direct body read on Node - `c.req.json()`, `c.req.text()`, `c.req.arrayBuffer()`, `c.req.bytes()`
  on a raw-body route - now reads straight off the socket instead of first building the Web `Request`
  the adapter had been deferring. The body cap is unchanged and still enforced by the same bounded
  reader: an over-cap `Content-Length` is rejected before buffering, a chunked body is still aborted
  mid-stream rather than buffered first, `clone()` inherits the cap, and `c.boundedBody(explicit)`
  still overrides it in either direction. `c.req` keeps its identity and every other member behaves
  as before. Net: a raw-body `POST` that reads through `c.req` gets a large throughput gain - roughly
  +65% on the JSON-body workload in the Bun HTTP framework benchmark on Node - and is no longer the
  slowest lane in a nifra app.
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

### Patch Changes

- fba30c7: A route that validates its body no longer arms the direct-read body cap on `c.req`. That lane
  already reads and bounds the body - at the route's own limit - before any derive, hook, or handler
  runs, so on a validated route the extra per-request cap only ever guarded a body that was already
  consumed. Dropping it removes a per-request write on the request object that, on V8, reshaped it
  every request and fed avoidable GC churn. Raw-body routes (no body schema), where a direct `c.req`
  read is the only body boundary, keep the cap exactly as before. Net: lower per-request allocation
  and a markedly tighter tail on validated `POST`/`PUT` routes, most visible on Deno.

## 2.12.0

### Minor Changes

- df100d3: Route-assurance rules can distinguish enforcement from assertion, and can select routes by data
  sensitivity.

  - **`requireProvenance`** on a rule: `"any"` (default, unchanged) accepts every evidence entry;
    `"runtime"` accepts only evidence installed by middleware, a plugin, or framework runtime policy
    and rejects an author's inline `schema.assurance` claim; `"declared"` is the inverse, useful for
    reviewing what handlers assert about themselves. Provenance is carried non-enumerably on each
    evidence entry, so existing reflected route descriptors keep their exact serialized shape.
  - **`requireCsrfWithAuthenticated`** on a rule: an authenticated route selected by that rule must
    also carry runtime CSRF evidence. Intended for rules covering cookie- or session-authenticated
    browser routes; bearer-only APIs have no ambient-authority exposure and belong in their own rule.
  - **`match.classificationAtLeast`**: select routes whose declared response classification is at
    least `"public"`, `"pii"`, or `"secret"`, so a policy can demand more of the routes that carry
    more.

  A failure message names the required provenance when it is not `"any"`, so the report says which
  kind of evidence is missing rather than only which id.

- 0efacea: Add a generic server `onStop` lifecycle hook and have OTLP tracing exporters flush and shut down automatically when attached to a server. Manual OTLP lifecycle calls remain available for standalone exporters.
- df100d3: Canonical project evidence: a single reflected snapshot of a project's routes, schemas, assurance,
  and capabilities, exported as `@nifrajs/core/evidence` (`snapshotProjectEvidence`). Tools that used
  to reflect the app a second time now project from the snapshot instead, so the manifest, the check
  report, and introspection cannot disagree about what the app declares.

  `createManifest` accepts the snapshot as `evidence` and skips its own reflection when given one. It
  refuses to emit a manifest whose route-assurance or capability evidence is failing, so a manifest is
  never a record of a project that does not pass its own gates. The previous `source` input still
  works; one of the two is required.

- b5f47c0: `__Secure-` and `__Host-` cookie name prefixes (RFC 6265bis) are now enforced, matched
  case-insensitively the way browsers match them. `serializeCookie` throws on a `Set-Cookie` that
  violates its name's prefix contract - `__Secure-` requires `Secure`; `__Host-` requires `Secure`
  and `Path=/` and forbids `Domain` - instead of emitting a cookie the user agent silently discards.
  `c.set.cookie`'s secure defaults already satisfy both contracts, so prefixed names work with zero
  configuration, and `c.set.deleteCookie` applies `Secure` to the deletion write for a prefixed name
  so the browser accepts the deletion (the failure mode behind Hono's CVE-2026-39410 class: a
  non-conforming deletion leaves the cookie alive after logout). The new `cookieNamePrefix(name)`
  export classifies a name as `"secure"`, `"host"`, or unprefixed. `@nifrajs/i18n`'s `localeDetector`
  applies `Secure` automatically when its persist cookie name carries a prefix.
- fc33c0f: The server type records which copy of `@nifrajs/core` declared it. `Server` carries a type-only
  `__nifraCoreVersion` brand holding the package's feature version (`major.minor`), exported as
  `NifraFeatureVersion`, so a hover over `typeof app` - or an assertion in a test - says which core an
  app is built against. Nothing is emitted at runtime and no field is allocated per server.

  Two copies of core in one build stay a compile error, as before; `nifra doctor` is what names the
  two install paths.

- c4e8bb0: New `errorLogDetail` server option controls how much of an unhandled error reaches the log for a 500:
  `"full"` (the default, unchanged - name, the error's own text as `detail`, and `stack`), `"message"`
  (no stack), or `"none"` (name only). None of it ever reaches the client; a 500 response is a bare
  `internal_error` either way. An error's text can quote the input that produced it, so an app whose log
  sink is outside its trust boundary can now narrow what is recorded - the sharper instrument stays the
  redacting logger (`jsonLogger({ valuePatterns: commonSecretPatterns })`), which scrubs tokens and
  emails out of `detail` and `stack` while keeping the diagnosis intact.
- 11d1658: `assure(app, evidence)` from `@nifrajs/core/assurance` publishes enforcement evidence from outside
  the plugin chain. When the thing enforcing a control is not a nifra plugin - an edge gateway, a
  service mesh, an outer framework that owns the shell wrapping the app - the assurance policy had no
  way to see it, and the only way to keep the app green was switching the affected rules off. The
  evidence can now be attached at the mount site or immediately before `serve`, after every route is
  registered:

  ```ts
  import { assure, NIFRA_ASSURANCE } from "@nifrajs/core/assurance";

  const app = buildApp();
  assure(app, { id: NIFRA_ASSURANCE.AUTHENTICATED, source: "edge-gateway" });
  serve(app);
  ```

  `scope` defaults to `global`, so the evidence applies to every route already registered; narrow it
  with `methods` and `paths` (absolute globs), or pass `scope: "subsequent"` to cover only routes
  registered after the call. Invalid evidence ids and `scope: "plugin"` fail closed at the call.

  Attached evidence always carries `declared` provenance - nifra did not install the enforcement and
  cannot observe it - so a rule with `requireProvenance: "runtime"` still rejects the route. Evidence
  declared through `withRouteAssurance` now carries the provenance it was given rather than always
  reporting `runtime`.

  It lives on the `assurance` subpath and applies through the ordinary middleware seam, so an app that
  never calls it carries none of this: the bare server bundle is unchanged.

- 8847825: Add `app.mountFetch()` for mounting an arbitrary fetch handler below a path prefix, with optional prefix stripping and platform argument forwarding. Mounted handlers are explicitly outside typed response-contract enforcement.
- 9a9346e: `merge()` now scopes a group's `onRequest` hooks to the group's own routes, following the same locality rule its `derive`/`beforeHandle` chains already obey: a `bodyLimit()` mounted on an uploads group no longer starts gating every route of the app that composes it in. The guard is a single route probe against a snapshot of the group's catalog, so requests outside the group pay one lookup and pass untouched; the group's Node-native hook twins are scoped the same way. Global assurance declared by a group's middleware follows the enforcement - it is folded onto exactly the merged routes, so `routes()` never claims a group's protection for parent routes its hooks do not see.

  A group with hooks but no routes is a middleware bundle: its hooks can only mean app-wide intent, so they are still appended globally, unchanged. Apps that relied on a route-carrying group's hooks running app-wide should register that middleware on the parent server with `.use()`.

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

- b045f9e: JSON bodies are now guarded against prototype poisoning. A payload carrying an own `__proto__`
  key, or a `constructor` whose value carries a `prototype`, is rejected with the same flat `400`
  as malformed JSON - before validation and before the handler. The new `protoPoisoning` server
  option selects the policy: `"reject"` (default), `"strip"` (delete the keys in place and
  continue), or `"ignore"` (opt out). The check covers the schema body lane, `c.boundedJson`, the
  streaming no-length path, and `\u`-escaped spellings of the poisoned keys; the transport-codec
  lane enforces the same policy on its own decoder via a matching `protoPoisoning` plugin option.
  The common clean payload keeps the runtime's native fast path - the guard is a single iterative
  pass over the parsed value, allocation-free, and benchmarks within noise of the unguarded
  baseline.
- 9a9346e: Routes and contract operations accept a `headers` schema, validated at the boundary alongside
  `body`, `query`, and `params`. Field names are materialized lower-case onto a null-prototype record
  before validation, so a hostile field name (`__proto__`, `constructor`) cannot reach
  `Object.prototype`, and repeated fields arrive already comma-joined by the platform. The validated
  result is available to the handler as typed data instead of ad-hoc `c.req.header(...)` reads, and a
  failure answers the same flat `400` as any other input-validation failure.

  The section flows through the rest of the surface: contract diffs report `headers` as its own
  breaking-change section, and OpenAPI generation emits the schema as `in: header` parameters.

- 9a9346e: Per-route transport body caps. A route or contract operation may declare `bodyLimit` - a byte count,
  or the explicit string `"unlimited"` paired with a `bodyLimitReason` that records why the route is
  exempt. The route's cap overrides the server-wide `maxBodyBytes` for that route only, so a single
  upload endpoint no longer forces the whole app's ceiling upward, and an exemption is a reviewable
  declaration rather than a silent absence. An invalid value - a cap that is not a non-negative safe
  integer, `"unlimited"` without a non-empty reason, or a reason given without `"unlimited"` - is a
  `RouteConfigError` carrying the `INVALID_BODY_LIMIT` code at registration, not a surprise at request
  time.
- dbc0b79: Signing-secret rotation. `signValue`/`unsignValue` (and the new `CookieSecret` type), session `secret`, and CSRF `secret` now also accept a rotation list: the first secret signs, any listed secret verifies, so keys rotate without invalidating live cookies, sessions, or CSRF tokens. Every listed secret must meet the 32-byte floor and an empty list throws; the single-secret path is unchanged.
- a5d3f5b: Add stable diagnostic codes, application-supplied rule packs, fix recipes, assurance bundles, contract lock snapshots, hydration assurance hooks, replay metadata, security verification rules, and idempotency proofs.
- 00819c5: `createToolHttpHandler` caps its JSON request body. The handler is standalone - it is not mounted on
  a server and so inherited no `maxBytes` - and used to read the body unbounded, documenting the limit
  as the mounting platform's job. It now defaults to 1 MiB (`DEFAULT_TOOL_MAX_BYTES`), configurable
  with `maxBytes`. An oversized body answers a flat `413` and a malformed `Content-Length` a flat
  `400`, both before the parse, so nothing oversized is ever materialized as a JS value.

  Running uncapped stays possible but must be declared: `maxBytes: "unlimited"` requires a non-empty
  `maxBytesReason`, and a reason without `"unlimited"`, or a cap that is not a non-negative safe
  integer, throws when the handler is created rather than at request time.

  **Breaking for bodies over 1 MiB.** A tool whose inputs legitimately exceed that must set `maxBytes`
  to its real ceiling, or opt out with a reason.

- e2d1939: Add typed tool contracts with shared fail-closed adapters, static verification work graphs, bounded provider-neutral agent turns, deterministic trajectory replay, and an explicit execution-policy seam with a non-isolating local process adapter.
- e83e6eb: A capability provenance rule that matches nothing is now a finding. Seam specifiers in
  `provenance.imports` and `provenance.routeModules` are compared with the text the code imports, so a
  rule written as `src/db` when the module is imported as `./src/db.ts` silently governed zero
  modules - the policy looked satisfied because nothing was ever attributed to it. `nifra check` now
  reports `unmatched-provenance-seam` for every declared seam no scanned source matched, with the
  nearest specifiers that were actually seen ("did you mean ...?") and a fix that points at rewriting
  the rule to match the import, or deleting it.

  `forbiddenImports` is deliberately excluded: zero matches there is the success state.

  A rule that is genuinely absent in some projects sharing one policy can opt out with
  `optional: true`, which suppresses the finding for that seam only.

### Patch Changes

- cd1732c: The body-size cap now holds on the bytes actually delivered, not on what the request declared.
  The `Content-Length` fast path re-checks the real byte count after the read: a source that hands
  over more bytes than it declared - a lying client or an adapter that decodes/expands the body
  upstream - is rejected with the same flat `413`, even though its header passed the fast-reject
  hint. One integer comparison on a buffer already in hand; the streaming lane already counted real
  bytes and is unchanged.
- 9a9346e: A contract operation's client-visible `body` and `query` types are now the schema's INPUT side, not
  its output side - matching what the inline registry already does. A schema that fills in defaults
  made the contract client demand the post-validation shape, so a caller had to send fields the schema
  exists to supply. Handler-facing context types are unchanged and still carry the validated output.
- 5f71c23: Cut iterator overhead from the async lifecycle chain, the static-header pass, and cookie signing.

  An array iterator declared inside an async function stays live across the `await` that follows it, so
  neither JSC nor V8 sinks it: the `beforeHandle`/`onError` chains paid 43ns per hook on Bun and ~9ns
  on Node for iteration alone. The static response-header pass paid it twice per header, once for the
  list and once for the pair destructuring (211ns per response on a 5-header set), and signed cookies
  paid it per digest byte (238ns per signature on Bun). All three now index directly.

- 3788b36: Walk arrays by index in the prototype-poisoning guard.

  A JSON body that is mostly array data was walked through the array iterator protocol, which JSC does
  not elide: on Bun a 9KB array of numbers cost 27us to guard instead of 2.2us, and the gap scaled
  with the body cap. The guard now indexes the array directly, which measures identically on V8 and
  removes the amplification on JSC.

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

- bd5c624: Collapse the JSON body lane onto one guarded path and make the poisoning walk cheaper.

  Framed JSON bodies now take the runtime's fused `json()` at every size instead of splitting at 1KB,
  and the guard walks the parsed value directly - the raw-text substring pre-scan is gone, since it
  cost more than the walk it was meant to avoid. The walk itself only stacks object nodes, so scalar
  keys and scalar array elements no longer make the round trip through it.

  No behaviour change: the same payloads are accepted, and the same poisoning shapes - including ones
  spelled with `\uXXXX` escapes - are still rejected or stripped under `protoPoisoning`.

- e2bdd4a: `createToolHttpHandler` applies the prototype-poisoning policy to its JSON request body. A body
  carrying an own `__proto__` key, or an own `constructor` key whose value holds an own `prototype`,
  is rejected with the same `input_invalid` tool result as malformed JSON, so probing cannot
  distinguish a blocked payload from a syntax error. The handler is standalone (never mounted on a
  server), so it carries its own `protoPoisoning` option - `"reject"` (default), `"strip"`, or
  `"ignore"` - mirroring the server option. The body remains read unbounded; cap request size at the
  platform or server mounting the handler.
- f8b0097: A `.ws()` route's `maxPayloadBytes` is now enforced on every runtime, not only the ones whose socket
  implementation happened to police it. The declared cap travels with the upgrade outcome, so the Node
  bridge hands it to `ws` as `maxPayload`, and the Deno and Workers/`attachWebSocket` message paths
  measure the frame and close with `1009 message too large` instead of delivering it. A route that
  declares no cap is untouched and pays nothing: sizing a text frame costs a UTF-8 encode, so the
  measurement only runs where a cap exists.

## 2.11.0

## 2.10.0

### Minor Changes

- 15bffdd: Serve `public/` with byte ranges. Static files now advertise `accept-ranges`, answer a single-range request with `206` and `content-range`, return `416` for an unsatisfiable range, and publish `last-modified` with `if-modified-since` and `if-range` handling. HEAD reports the same `content-type` and length metadata GET does. `parseByteRange` moves to `@nifrajs/core/range` so the static handler and `@nifrajs/middleware`'s `rangeResponse` share one parser; the middleware export is unchanged.
- 15bffdd: Add request-bound data capability evidence, resumable bounded channel subscriptions, ISR tag
  invalidation for memory and KV stores, and dependency-free Open Graph image responses with an
  optional rasterizer seam.
- 15bffdd: Add standards-shaped range, conditional, content-negotiation, and multipart response helpers, plus public token-only data contracts and typed in-memory channel seams.

## 2.9.1

### Patch Changes

- 01e36fb: HEAD requests now answer via the matching GET route with identical status and headers (RFC 9110), on both the Bun native-route lane and the portable dispatcher. Previously a HEAD to a GET-only route returned a 405 JSON error, so custom headers and the declared content-type were lost. An explicitly registered HEAD route still takes precedence, and 405 Allow lists now advertise the implicit HEAD support.

## 2.9.0

### Minor Changes

- e05e56d: Improve hot paths across runtimes and the browser: a validated-POST fused lane for Bun/Deno Web
  requests (measured +12.7% Deno, +3.5% Bun on `POST /users`) plus a registration-compiled body
  validation/handler continuation shared by Web and Node-direct (about 9.6% faster than the generic
  body lane in-process), client route matching indexed on the core router instead of a linear scan
  (measured ~18x faster on a 100-route app), search-param parsing in one pass instead of O(keys²), and
  allocation-free fast paths for static asset URLs and safe SSR script serialization.
  Bare fused-lane Web requests with no active timeout or deadline now run on the lazy request
  context (the one the Node direct path already uses), with the platform - `c.env`, `c.clientIp`,
  `c.waitUntil` - carried through and `c.signal`/`c.budget`/`c.query` resolving lazily to identical
  values, pinned by a regression test. Measured +4.5% on a bare `GET /users/:id` on Deno. Routing
  also stops allocating a `{ pathname, search }` pair per request on the portable path.
  Node serving now keeps synchronous Web request middleware on the direct renderer, adapts in-place Web
  response middleware back to direct buffered writes, and avoids redundant params/body lifecycle stages
  for common validated reads. Header-only built-ins (`cache-control`, `powered-by`, and related response
  mutators) no longer clone buffered responses on Node.
  New portable middleware hook: `onResponseBody(body, headers, req, status)` - the post-serialization
  payload tier. The hook receives the FINAL framework-serialized bytes plus the mutable header view,
  and may return replacement bytes. On the Node direct writer the bytes come straight off the outcome
  record; on the Web serving paths they ride the framework-built Response as an inert tag (attached
  only once a body hook is registered), so no body stream is ever drained on any runtime. A
  handler-returned raw `Response` (a proxied fetch, SSE, a streamed page) is skipped by contract, a
  structured return (`{ body, status }`) can drop the body or change the status (an ETag `304`), and
  transforming those remains `onResponse`'s job. A body-observing middleware written this way
  measures at ~92% of a raw `node:http` server on the realistic route, vs ~50% through the full
  `onResponse` contract.
  New middleware hook: `onResponseRaw(response, req)` - the raw-response tier. It runs ONLY for
  responses the payload tier skips (streams, proxied fetches, and framework-generated error
  responses); a framework-serialized JSON body stays on `onResponseBody` and, on Node, on the direct
  socket writer (the raw hook self-pairs with a no-op native twin, so registering one does not force
  the fallback path). Together the two tiers cover every response without double-processing any.
  Response-body tagging is now scoped per app instance instead of process-wide: one app registering a
  body hook no longer makes unrelated apps in the same process pay for tagging, `merge()` keeps the
  tag readable across merged apps, and a foreign Response carrying a look-alike marker is not treated
  as a framework-serialized body.
  Bodiless statuses are normalized on every render path: a handler returning a `204`/`205`/`304` (or
  a body hook converting to one, e.g. an ETag `304`) always ships with no body and no
  `content-length`, on the Web paths and the Node direct writer alike.
  Response-header records are built null-prototyped everywhere user-influenced names can land in
  them, so header names like `__proto__` stay data instead of touching the record's prototype; the
  header view over Node outcomes also resolves names via a one-time per-request index instead of
  scanning the record on every get/set (measured at roughly a fifth of the framework's own CPU on a
  realistic middleware-carrying route).
  Guarded response headers (a raw `fetch()`ed Response) are now detected with a reversible probe
  before any header hook runs, instead of catching the mutation `TypeError` and re-running the hook
  against a clone - a hook that itself throws `TypeError` no longer runs twice. Framework-constructed
  responses stamp their headers as known-mutable at construction, so the hot path answers that
  question with a single weak-set lookup and only a handler-returned foreign `Response` ever pays the
  probe, once per headers object.
  New portable middleware hook: `onResponseHeaders(headers, req, status)` - the recommended shape for
  response middleware that only reads or writes headers. One implementation runs on every runtime: on
  the Web serving paths it mutates the response's own `Headers` inside the normal response walk (no
  clone), and on Node it self-pairs as a native hook against the outcome record, so registering one
  never forces the Node adapter off its direct socket writer the way a full `onResponse(res:
Response)` hook does.
  Native Node hook lanes now engage as a unit - the response-side native hooks run only when the
  request side is native too - which makes the native request context's identity stable across a
  request; the context also carries `url`, and both are documented so middleware twins can key
  per-request state on it. Building a Web `Request` from a Node request fills its header list once
  from a plain record instead of copying a prebuilt `Headers` a second time.
  Query and cookie parsing intern repeated key names on V8-based runtimes (Node, Deno) through a small
  bounded cache - V8 pays ~13x to store a freshly-sliced string key on the null-prototype records the
  parsers build, so handing back the first-seen key makes the store take the fast path. High-cardinality
  or oversized keys bypass the cache and behave exactly as before, and JSC (Bun) skips the scheme
  entirely (it has no such cost).
  When any route registers `onResponseBody`, every JSON response with caller-set headers (the common
  shape once a route has middleware) stopped pre-building a throwaway `Headers` instance just to
  check for an existing `content-type` - that instance was immediately handed to `new Response()`,
  which does its own header ingestion regardless, so the pre-build was pure waste. The check now runs
  against whatever shape the headers already are (a plain record gets a shallow copy only when
  `content-type` is absent; an already-built `Headers` is mutated in place, as before) and that result
  goes straight into the `Response` constructor. Deno/V8 charged far more for the discarded `Headers`
  instance than Bun/JSC did - measured previously as the entire gap between the payload tier's Deno
  row and its own raw ceiling on the realistic-shape benchmark; that row now leads every peer
  framework and sits within a few percent of raw `Deno.serve` again.
  On Deno, JSON responses that carry caller-set headers are now built as a bare `Response` whose
  headers are set individually afterwards, instead of handing the header record to the constructor -
  Deno charges far more to ingest a header-record init than to mutate a built response's `Headers`.
  The runtime's own `Response.json` content-type is probed once and reused, so the wire contract is
  exactly what `Response.json` ships on that runtime, and Bun keeps the constructor path it measures
  faster on. Measured +7% on the realistic middleware GET row and +12.7% on its body-hash variant;
  with this, the realistic Deno rows lead the closest peer framework on both GET and POST.
  The native header view's one-time name index is now authoritative for every operation, including
  writes of names not yet present: setting a new header no longer walks and lowercases the whole
  record on the way in, which had made each fresh `set()` cost grow with the headers already written
  (measured +2.2% end to end on the realistic middleware-carrying Node GET row). Case-insensitive
  reads still cover the record as first seen plus everything written through the view; a native twin
  writing the record directly uses lowercase names - the wire form the record documents.
  New response tier: `app.responseHeaders(record)` (and `responseHeaders` on a middleware bundle) for
  response headers with no per-request decision behind them. Declaring them registers no response hook,
  so the values fold into response construction - one prebuilt init for JSON renders, one record merge
  where the request set its own headers - and an app whose response middleware is only static keeps the
  lanes a hook closes: Bun's fused native routes, and the Node direct socket writer that a full
  `onResponse` gives up. They still apply to every response a hook would cover (success, error,
  404/405, timeout, short-circuit), byte-identically to registering the same names as an
  `onResponseHeaders` hook, on every runtime - pinned by parity suites over `app.fetch`, the Node
  adapter's own socket writes, and the Deno serve path. Declared headers are DEFAULTS: a value the
  request produced (`c.set.headers`, or a response hook) wins, whatever casing it used, and one name
  spelled two ways still ships as one header line. Names are lowercased once at wire-up; a non-string
  value, an invalid name, `__proto__`, or a name the render owns (`content-type`, `content-length`,
  `transfer-encoding`, `set-cookie`) throws a `TypeError` there instead of surfacing on the wire.
  Declarations made before any response hook merge into one record; one made after a hook registers as
  an ordinary header hook so registration order is preserved.
  `securityHeaders()` and `poweredBy()` (in its default respect-existing configuration) now declare
  their headers instead of writing them from a hook: measured +11% on a bare Bun `GET` behind
  `securityHeaders()`, within noise on Node and Deno (where the per-response header writes, not the
  response walk, dominate). Middleware whose headers depend on the request keeps the hook - `cors`
  reflects an origin, and `cacheControl` gates on method and status.

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.

## 2.8.1

### Patch Changes

- 78d66a4: Node serving got measurably faster - ahead of Fastify on every workload in our benchmark, where it previously trailed by ~2%. Three changes, all behavior-preserving:

  - Buffered responses (node-direct JSON and SSR body outcomes) now declare `Content-Length` instead of falling back to `Transfer-Encoding: chunked` - a known-length body never needed chunked framing, which cost extra wire bytes and client parsing on every response, and no other runtime chunked these.
  - The socket-peer platform object is built once per connection and reused across keep-alive requests (the peer address cannot change mid-socket).
  - Routing on Node now splits pathname/search straight from the origin-form request target; the absolute URL is only synthesized if something actually reads `c.req.url`. `RequestSource` gained an optional `urlParts` field for sources that already hold the split target.
  - An absent-header probe no longer falls through to the source's `Headers` object: a source-implemented `header()` returning `null` is authoritative. The fallthrough was materializing a full `Headers` on every POST (the body lane's `transfer-encoding` check), measured at ~4% of request CPU - the POST lane on Node is ~9% faster without it.

- 93fdc89: Fix the unhandled-request-error log so it carries the error's own message.

  The record is built by spreading the caller's fields and then setting the framework's own keys, so
  `level`, `message`, and `time` always win. The error log passed the thrown error's text as `message`,
  which meant it was overwritten by the log message itself and never reached the sink:

  ```json
  {
    "method": "GET",
    "path": "/boom",
    "name": "Error",
    "message": "unhandled request error",
    "stack": "Error: kaboom\n at ..."
  }
  ```

  The real text survived only incidentally inside `stack`, and was lost outright for a non-`Error`
  throw, which has no stack to hide in. It is now emitted as `detail`, matching the response-contract
  logs:

  ```json
  {
    "method": "GET",
    "path": "/boom",
    "name": "Error",
    "detail": "kaboom",
    "stack": "Error: kaboom\n at ..."
  }
  ```

  This is a shape change for anything parsing these lines. A consumer reading `message` on an error
  record now gets the constant `"unhandled request error"` in every case rather than sometimes-there
  diagnostic text - it was already that constant, so nothing loses information, but a dashboard or
  alert grouping on that field should move to `detail`.

## 2.8.0

## 2.7.1

### Patch Changes

- 52c89e0: Query-validated routes now take the fused Web lane. A route whose only lifecycle step is a query schema (no body/params schema, no hooks, no idempotency/ledger, no validation-error recovery) compiles parse + validate + handler + respond into one closure: with a sync validator and handler there is no lifecycle promise at all. Semantics are unchanged - the 422 contract, thrown-Response control flow, repeated-key promotion, async validators, `c.set`, decorations, and `merge()` all behave exactly as the generic lane, and any recovery hook or wrapper keeps the route on that lane. This is the biggest win for validated GET endpoints on V8 runtimes (Node, Deno), and it speeds up Bun too.

## 2.7.0

## 2.6.1

### Patch Changes

- 5840c98: Two hot-path costs removed. On Bun, the socket peer address is now resolved lazily: `c.clientIp` keeps its documented raw-peer behavior, but the underlying `requestIP()` lookup (surprisingly expensive per request) only runs when something actually reads it - trust-mode routes still resolve it before the handler. On Node, buffered SSR responses no longer clone the response-header record (and every Set-Cookie array) before `writeHead` - the producer already hands over response-normalized names and values.

## 2.6.0

### Patch Changes

- e6349e5: Security hardening across input parsing and code generation. Every regex that runs on caller-influenced input (URL paths, route patterns, stylesheet and SVG sources, manifest text) is now linear - no polynomial backtracking on adversarial input. SVG preamble stripping and tag removal can no longer splice removed delimiters into new markers. Static file serving rejects `..` traversal in the request form outright and confines the resolved path with a `relative()` containment check. Generated code embeds strings through an escaper that neutralizes `</script>` breakout and the U+2028/U+2029 line separators, and HTML entity decoding resolves `&amp;` last so double-encoded entities cannot double-unescape.

## 2.5.0

## 2.4.0

### Patch Changes

- 138bfba: Route precedence now has one home: a `sortRoutesBySpecificity` helper on `@nifrajs/core/pattern` orders compiled routes most-specific-first (a static segment beats a dynamic one). The web router, the mock server, and the editor plugin all order routes through it, so which file a path resolves to stays identical across runtime, client, and editor.

## 2.3.0

### Minor Changes

- 6f5b3ad: Assurance rules can match a CLASS of capability rather than a list of token names.

  ```ts
  { name: "authenticated-write", match: { access: "write", zone: "domain" }, require: [AUTHENTICATED] }
  ```

  Naming exact tokens is precise but closed. A rule listing `db.write` does not cover `storage.write`, so
  every policy has to enumerate every write in the system, and a capability introduced next year escapes
  the rule until someone remembers to widen it. `access` and `zone` are read from the capability
  definitions, so the rule is keyed on what the capability IS - a new token is covered the day it is
  declared.

  Both constraints must hold for the SAME capability: a route that reads business state and writes an
  audit log does not satisfy `{ access: "write", zone: "domain" }` by combining halves of two tokens.

  The selectors resolve through the capability definitions, so `evaluateRouteAssurance` takes them via a
  new third argument (`{ definitions }`) and `defineAssuranceConfig` refuses a policy that uses them
  without a `capabilities` block. Without definitions such a rule could only ever match nothing - and a
  rule that matches nothing does not fail, it lets the route fall past to whatever laxer rule comes next.

- 85b354d: Assurance rules can match on a route's declared capabilities, and a misspelled selector key is now an error.

  ```ts
  { name: "authenticated-write", match: { capabilities: ["db.write"] }, require: [NIFRA_ASSURANCE.AUTHENTICATED] }
  ```

  A path glob is the wrong tool for "anything that writes must prove who asked": it breaks when a route
  moves, and it cannot see a route that acquires the capability later. The declared tokens already reach
  reflection, so a policy can be written against what a route DOES. Matches when the route declares any of
  the listed tokens.

  Every `create-nifra` template ships this rule, which is what stops a server function - a public POST
  endpoint whose arguments the caller controls - from shipping unauthenticated.

  The selector is rebuilt from an allowlist of known keys, so an unrecognised one used to be dropped
  silently. A selector that loses its only constraint matches EVERY route, so the rule swallows
  everything after it - in a policy whose first rule is the lenient one, a single typo disabled the rest
  of the file. Unknown selector keys are refused rather than ignored.

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

- ea0a27f: Capability provenance says when it could not finish, instead of reporting a clean project.

  The reachability walk stops at a module count and an import depth so a pathological graph cannot hang
  the check. Hitting either limit used to end the walk quietly, and the route came back covered - a
  passing report whose subject was partly unexamined, which is the shape of failure this whole gate
  exists to prevent.

  Both limits now produce a `provenance-truncated` finding naming the route and the chain that reached
  it, the check fails, and the lockfile refuses to record a snapshot taken from a truncated walk.

- b271164: Add `responseContract()`, an opt-in plugin that makes a route's declared `response` schema hold at runtime.

  A `response` schema is a lower bound: it says "at least these fields", never "only these". A handler
  that returns a database row satisfying it also ships every other column, and nothing points at it -
  TypeScript's excess-property check does not reach a handler's return position, and the client's type
  reports the contract rather than the bytes. The result can appear with no code change at all: add a
  column, and the next deploy ships it to browsers.

  ```ts
  import { responseContract } from "@nifrajs/core/response-contract";
  app.use(responseContract("enforce"));
  ```

  - not installed (default) - unchanged behaviour, and the lane is absent from the bundle entirely.
  - `"warn"` - checks each response, logs the undeclared fields by name, serves the payload unchanged.
  - `"enforce"` - serializes the validated value, so undeclared data cannot reach the wire.

  Enforcement follows the schema's own semantics, since Standard Schema exposes `validate` and no way to
  enumerate declared keys: a stripping schema (Zod, Valibot) yields a cleaned value, while a strict one
  (`@nifrajs/schema`'s `t.object`) reports issues and the response becomes a 500 with the detail logged
  rather than returned. Routes with a `response` schema leave the fused and native fast paths while this
  is enabled, the same trade an idempotent route makes.

  It is a plugin rather than a server option so that apps which do not use it do not carry it: as an
  option the check was statically imported by the kernel and cost every app ~0.5 KB gzip, which the
  bundle-size gate caught. Behind the `@nifrajs/core/response-contract` subpath the lane arrives only
  when installed, and the kernel keeps just the install seam (~0.2 KB).

- 5fe332a: A route can declare that it returns bytes, and the client types it as `Blob`.

  ```ts
  import { bytes } from "@nifrajs/core/binary";

  app.get("/invoice.pdf", async (c) =>
    bytes(await render(c.params.id), {
      type: "application/pdf",
      filename: "invoice.pdf",
    })
  );
  ```

  Sending bytes was always possible - return a raw `Response` - but a raw `Response` is exactly what the
  typed client cannot describe. So a download route needed a `// nifra-expect raw-response` pragma to
  quiet the drift advisory, and its caller got no type at all. One category of endpoint sat outside the
  contract the framework is otherwise strict about.

  `bytes()` closes that. The brand it carries is a phantom - nothing is added to the value at runtime -
  and it exists so the type can say a thing the value cannot: that these bytes are the payload rather
  than a serialization accident. A plain `Response` is unaffected and still types as it did.

  `filename` handles anything a person can type. Characters that would end the header value early are
  stripped, and a name ASCII cannot carry is encoded per RFC 6266 (`filename*=UTF-8''...`) rather than
  throwing - setting a header containing `\u62a5\u544a.pdf` or an emoji raises, which on a download route
  would be a 500 for the ordinary act of naming a file, and the name is usually the user's own.

- d2840ac: A safe-method route that can reach a domain write is reported once, with the fix it actually has.

  It used to draw two findings giving opposite advice: `undeclared-capability-evidence` (declare what you
  reach) and `safe-method-domain-write` (a safe method may not declare a domain write). Both are correct
  and together they are a dead end - the route cannot declare its way out, because the declaration was
  never the problem.

  Reach is computed from the module that registers a route, so a read endpoint sitting beside a write
  seam has write powers in scope. The new `unconfined-write-reach` finding says that, and says to move
  the route or the effect. Still an error, and the report still fails; a GET that explicitly DECLARES a
  domain write is unchanged, because that one really is an HTTP semantics mistake.

### Patch Changes

- ea0a27f: A durable table prefix cannot collide after PostgreSQL truncates it.

  **Breaking for prefixes longer than 45 characters**, which now fail at construction rather than later.
  PostgreSQL truncates identifiers to 63 bytes, and this adapter appends up to `_records_reconcile` (18)
  to the prefix. Two distinct prefixes long enough to be cut short became one table name, silently
  sharing state between what the caller believed were separate deployments. The accepted length now
  reserves the longest suffix, so an accepted prefix survives truncation intact.

  Both adapters also assemble their statements through a tagged template that validates every
  substitution as an identifier at the boundary, so the check is at the seam rather than trusted from a
  caller several frames up.

- 8c77d47: The response size limit is reachable, applies to text as well as JSON, and never applies to a download.

  ```ts
  client<App>(url, { maxDecodedBytes: 64 * 1024 * 1024 });
  ```

  `maxBytes` lived under `transport`, whose `codec` is required - so raising your own response limit
  meant opting into a versioned transport representation you had not asked for, and the call did not
  compile without it. The 16 MB default protected everyone while the knob was reachable by nobody. It is
  a top-level option now, with a doc comment saying what it bounds.

  It bounds text as well as JSON, because a 2 GB string costs what a 2 GB object costs and one number
  should answer for both. It deliberately does NOT bound a binary body: that is a download, and a size
  limit on a download is a bug rather than a defence.

  Exceeding it is a result, not a throw: `{ ok: false, status: 0, error: { error: "response_too_large" } }`,
  the shape a timeout already takes. It used to throw a `TransportCodecError` straight out of the client,
  which meant the only safe way to use the option was the try/catch the client's contract exists to
  remove. The older `transport.maxBytes` spelling still works and still wins for the transport path.

- ea0a27f: The same-origin check works behind a TLS-terminating proxy, and both seams that use it now agree.

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

## 2.2.0

### Minor Changes

- a4645e2: Support path segments that are part literal, part parameter.

  A route segment had to be wholly static, wholly a parameter, or wholly a wildcard. `/:key.txt`,
  `/post-[id].html` and `/[locale]-sitemap.xml` did not merely fail to match - they failed to
  **compile**. The trigger was an IndexNow key-verification file, which the protocol requires at
  `<origin>/<key>.txt` with the key coming from deploy-time config, and at the root, because a key
  served from a subdirectory only authorises URLs beneath it. The workaround was an exact-match check in
  the app's server entry, which moved a routing concern out of the router and never ran in dev.

  Both spellings now work: `:key.txt` in a route pattern, and `[inKey].txt.tsx` as a file route. The
  parameter name is the longest identifier run after `:`; everything else in the segment is literal.
  Precedence is static > mixed > param > wildcard, decided by shape rather than registration order, so
  `/robots.txt` still beats `/:key.txt` and `/jobs/:id.txt` beats `/jobs/:id`.

  Inside a mixed segment, `[[optional]]` and `[...catchAll]` are **rejected** at build time rather than
  given a meaning: there is no sensible absent form for `/[[locale]]-feed.xml`, and a catch-all captures
  the rest of the path, which a trailing literal can never follow.

  **Literal colons keep their meaning.** A `:` that follows an identifier character and runs to the end
  of its segment is literal, so the established RPC-style action shape - `/v1/things:batchGet` - still
  routes as written rather than capturing `batchGet` into a parameter named after the verb. Mixed
  parameters remain available everywhere they are unambiguous: at the start of a segment (`/:key.txt`),
  after punctuation (`/post-:id`), or with a literal suffix (`/v:major.json`). A `:` not followed by a
  valid identifier start (`/ratio:2`) is literal as before.

  Mixed siblings are ordered by ONE total comparator shared between the server's trie router and the
  browser's matcher. Ordering by literal weight alone left ties broken differently on each side, so
  `/bar.:value` and `/:value.foo` could resolve to different routes for the same URL - visible only as a
  soft navigation rendering the wrong page.

  Adding a mixed pattern can also make a previously unambiguous path ambiguous: with both `/jobs/:id` and
  `/jobs/:id.txt` registered, `/jobs/a.txt` now matches the mixed route with `id="a"` where before it
  could only match the bare param with `id="a.txt"`. Deterministic, and only for apps that opt in by
  registering a mixed pattern.

  An app that registers no mixed segment allocates nothing for this and pays one `undefined` check on
  the match path. The rejected-parameter hint added in the previous release is removed - `:id.json` was
  the shape it explained, and `:id.json` now compiles.

### Patch Changes

- 5f460db: Fix `nifra init-agents`, and explain rejected route parameters.

  `nifra init-agents` failed for every installed user with `Cannot find module 'create-nifra/agent-files'`.
  The `./agent-files` subpath resolves through the `bun` condition to `src/agent-files.ts`, which the
  published tarball did not contain - the package shipped `dist` and the templates only. It now ships
  that source file, so the subpath resolves from a real install. Reproduced from a packed 2.1.0 tarball
  before and after.

  An invalid route parameter now says why. Route grammar is per-segment - a segment is wholly static or
  wholly a parameter - so everything after the colon is the name, and `/v/:id.json` asks for a parameter
  literally called `id.json`. The previous `invalid parameter ":id.json"` read as a typo rather than a
  rule; the message now names the limitation and gives both ways out (`/v/:id/json`, or capture the whole
  segment and split it in the handler). Reserved names, an empty name, and a name that is invalid for
  some other reason each get their own explanation instead of sharing one.

  Note for anyone who has hit this: a segment that merely _contains_ a colon without starting with one,
  such as `/a/pre-:id`, is a literal static segment and captures nothing. That is deliberate - a colon is
  legal inside a URL path segment (`/v1/things:batchGet`) - and is now covered by a test that documents it.

- e713cab: Let a route loader answer 404 and 410.

  A matched route whose loader finds nothing had no supported way to set its page's status, so the path
  of least resistance was to return empty data and render "not found" inside a **200**. That is a soft
  404: search engines penalise it and keep the dead URL indexed, and because the page looks correct in a
  browser it ships and stays shipped. It is the most common page shape there is - a detail route whose
  record may not exist.

  `notFound()`, `gone()`, and `statusPage(status)` are thrown from a loader, the way `redirect()` already
  is. They render the `_404` page - or `_410.tsx` / `_<status>.tsx` if the app authored one - inside the
  normal layout chain, hydrated, at the right status. A `headers` option carries the cache policy each
  status wants: a 404 may be racing publication and wants a short TTL, while a 410 is a promise that the
  URL is permanently gone. Typed `never`, so a loader narrows without a redundant `return`.

  410 is not a pedantic 404: it tells a crawler to drop the URL instead of re-fetching it for weeks.

  Existing behaviour is unchanged by construction. The signal is a branded `Response` and the brand is
  checked before the verbatim pass-through, so `throw redirect(...)`, `throw new Response(...)`, and a
  real `Error` reaching `_error` all behave exactly as before. Client-side navigation and prerendering
  already handle a non-ok render correctly and now have tests pinning that: a soft-nav falls back to a
  full navigation and lands on the same page, and a prerendered path whose loader signals is omitted
  from the build rather than baked as a static 200 shell.

  `renderPageResult` gains a `headers` option. `content-type` and the ISR freshness header stay
  framework-owned and cannot be overridden through it.

  Also trims the router's rejected-parameter message added in the previous release. The explanation cost
  ~0.3 KB gzip in every bundle; it now states the grammar rule and the two ways out without building an
  example path, which is a third smaller and keeps the base bundle inside its budget.

- 6aa0aac: Add `previewEndpoint` for draft/preview mode, and make transport codec decode errors uniform.

  `previewEndpoint({ secret, draftSecret })` is a `fetch` handler for the link your CMS's "Preview"
  button points at: it checks the preview token in constant time, turns draft mode on with the signed
  `__nifra_draft` cookie, and redirects the editor to the requested page. It is the link-borne sibling
  of `revalidateEndpoint`, and it exists because gating the route by hand means writing two checks that
  are easy to get subtly wrong and that fail silently when you do - the token compare must not exit
  early on the first wrong character, and the `?to=` destination must not be allowed off-site
  (`//evil.com` and `/\evil.com` both start with a slash yet navigate away). Wrong or missing token
  gives `401`, an off-site destination `400`, and success a `302` carrying `Cache-Control: no-store`
  so no shared cache can replay one editor's draft session to a visitor. Param names, the fallback
  destination, and cookie lifetime/path/`Secure` are all configurable.

  `decodeTransportFrame` and `decodeTransportResponse` now raise `TransportCodecError` for a malformed
  payload instead of letting the underlying `SyntaxError` through, with the original kept as `cause`.
  Every other failure in that module was already a `TransportCodecError`, so a malformed payload - the
  likeliest hostile input - was the one case that slipped past callers catching the documented error
  type. `TransportCodecError` accepts an `ErrorOptions` second argument to carry that cause. Bytes that
  are not valid UTF-8 take the same path: the `TypeError` from the strict decoder used to escape ahead
  of any codec, so the one input that never reached a codec at all was also the one that reported
  differently from every other decode failure.

## 2.1.0

### Minor Changes

- bd294bb: Add `executeCapability()` as a correlated, policy-aware effect boundary.

  - Correlate intent and terminal evidence with a random `effectId`, record committed/failed outcomes
    automatically, and combine request cancellation with bounded async `aroundCapability()` admission
    policies while preserving the synchronous `useCapability()` path.
  - Retain idempotency results for every completed response, including non-2xx outcomes, so a retry
    cannot repeat an effect that succeeded before a later handler failure.
  - Add durable approval, effect journal, saga/compensation, and reconciliation primitives behind the
    `durable-execution` subpath, plus token-only OpenTelemetry effect spans from `@nifrajs/otel/effects`.
    Reconciliation supports bounded cursor pages, approval resume tokens stay out of ordinary error
    serialization, durable terminal states are monotonic, crash ambiguity has an effect-ID-bound operator
    resolution API, and unmatched effect spans have bounded retention.
  - Add one shared owned-effect scope across capabilities, saga execution, compensation, idempotency
    evidence, durable transitions, and telemetry. An explicit `markIdempotencySafeToRetry()` outcome
    releases a resolved 5xx only while the scope proves no effect began.
  - Add negotiated, versioned transport codecs with bounded plain-JSON and rich-wire adapters for HTTP,
    the typed client, loader NDJSON, and WebSocket frames.
  - Add Postgres, SQLite, and Durable Object durable-execution adapters with one reusable conformance
    suite, plus leased reconciliation workers with bounded pages/concurrency, durable cursors, filters,
    cancellation, backpressure, and token-only metrics.

- d3aac63: Add `@nifrajs/core/wire`: a rich-type JSON codec (`encode` / `decode` / `stringify` / `parse`) for RPC
  bodies, loader payloads, and WebSocket frames.

  Plain `JSON` drops `undefined`, stringifies `Date`, nulls `NaN`/`Infinity`, loses `-0`, throws on
  `BigInt`, and has no notion of `Map`, `Set`, `RegExp`, `URL`, `ArrayBuffer`, or typed arrays - so a
  typed client can receive a runtime value whose shape diverges from the type it inferred from the server.
  The codec round-trips all of those exactly, preserves shared-reference identity, and encodes cycles as
  back-references instead of throwing. Malformed input decodes to a typed `WireDecodeError`; functions and
  symbols are rejected on encode rather than silently dropped. Decode is secure by default: object keys
  cannot mutate prototypes, every node shape is validated, and configurable node/depth/collection/byte
  budgets reject resource-exhaustion payloads.

## 2.0.0

### Major Changes

- 82676e0: Optional server systems are now opt-in `.use()` plugins installed from dedicated subpaths - never server options, side-effect imports, or process-global registries.

  - Enable request idempotency with `.use(idempotency())` from `@nifrajs/core/idempotency-plugin` - pass `{ store }` for a durable app-wide default. The `idempotencyStore` server option is removed.
  - Enable the per-request effect ledger with `.use(effectLedger({ sink }))` from `@nifrajs/core/effect-ledger`. The `effectLedger` server option is removed.
  - Enable MCP declarations (`.tool()`, `.resource()`, `.prompt()`) with `.use(mcp())` from `@nifrajs/core/mcp`. The package root does not activate them implicitly.
  - Enable typed SSE routes (`.sse()`) with `.use(streaming())` from `@nifrajs/core/sse`.
  - Enable WebSocket routes (`.ws()`) with `.use(websocket())` from `@nifrajs/core/ws`. The old `import "@nifrajs/core/ws"` side-effect no longer installs the runtime.
  - A route that declares one of these without its plugin installed fails loudly at registration, so a gate can never be silently dropped by a forgotten plugin.

  Each plugin installs its runtime on that server instance only - two servers in one process never share opt-in state. Merging a configured sub-app with `.use(subApp)` carries its installed runtimes across.

  A `server()` that uses none of these pulls none of their code into its bundle, so the minimal server footprint is smaller.

  Migration:

  ```ts
  // before
  server({ idempotencyStore, effectLedger: { sink } });

  // after
  import { effectLedger } from "@nifrajs/core/effect-ledger";
  import { idempotency } from "@nifrajs/core/idempotency-plugin";
  import { mcp } from "@nifrajs/core/mcp";
  import { streaming } from "@nifrajs/core/sse";

  server()
    .use(idempotency({ store: idempotencyStore }))
    .use(effectLedger({ sink }))
    .use(mcp()) // if the app declares tools/resources/prompts
    .use(streaming()); // if the app declares .sse() routes

  // WebSocket apps:
  // before: import "@nifrajs/core/ws"; server().ws(...)
  // after:  import { websocket } from "@nifrajs/core/ws"; server().use(websocket()).ws(...)
  ```

  Standalone callers of `app.resolveNode()` opt in with `.use(nodeDirect())` from `@nifrajs/core/node-direct`. The `@nifrajs/node` adapter installs it on `serve(app)` automatically, so normal Node deployments need no change and keep the direct JSON fast path.

- a7b1d60: WebSocket routes are now enabled with `.use(websocket())` from `@nifrajs/core/ws`, matching every other opt-in system. The old `import "@nifrajs/core/ws"` side-effect no longer installs the runtime.

  The runtime installs on that server instance only (no process-global), so `app.ws()` without the plugin fails loudly at registration. Adapters and `@nifrajs/workers` still import `attachWebSocket` / `TopicRegistry` from the same subpath.

  ```ts
  // before
  import "@nifrajs/core/ws";
  const app = server().ws("/chat", handler);

  // after
  import { websocket } from "@nifrajs/core/ws";
  const app = server().use(websocket()).ws("/chat", handler);
  ```

### Minor Changes

- a7b1d60: Add `c.clientIp` - the caller's IP, derived correctly and vendor-neutrally.

  By default it is the raw socket peer the serving adapter observed (`listen()`, `@nifrajs/node`, `@nifrajs/deno` supply it; any caller can pass it via `app.fetch(req, { clientIp })`), the one address a client cannot forge - and never a forwarded header. Behind a reverse proxy or CDN, set the `clientIp` server option to derive the real caller from the forwarding chain as far as you trust it:

  - `server({ clientIp: { trustedHops: n } })` reads `X-Forwarded-For` past `n` proxies you operate (a short header fails closed to `undefined`);
  - `server({ clientIp: { header: "x-real-ip" } })` trusts one edge-set header's first value.

  Declaring trust the app can't enforce would let clients forge their IP, so it stays unset by default. `c.clientIp` is safe to key rate limits and audit logs on, and is resolved once before handlers, `derive`, and hooks run.

- eaac3d7: Route assurance reaches two places it couldn't before: in-handler guards and dynamic route families.

  - **Inline `schema.assurance`.** A route (or contract op) can declare the enforcement evidence it carries adjacent to the handler - `{ assurance: [NIFRA_ASSURANCE.AUTHENTICATED] }` - and each id reflects as route-scoped `declared` evidence. A route whose guard runs inside the handler body (invisible to reflection) can now satisfy a policy `require:` clause without being rewritten into a `withRouteAssurance`-marked middleware. Invalid evidence ids fail closed at registration.
  - **`flagClassifiedWithoutEvidence` policy option.** Opt-in. When set, a route matched by a pure-classification rule (no `require`, no `forbid`) that carries no evidence is reported as `classified-no-evidence` - making the "a classification-only policy silently degrades proof to a label" gap visible instead of green. Off by default (a genuinely public route legitimately carries no evidence).
  - **`schema.family` dynamic route families.** A runtime-resolved template (`/api/:slug/:resource` over tenant-defined tables, a catch-all dispatcher) can be marked `{ family: true }`. It surfaces as `family` in reflection, so the assurance gate and tooling read the one templated route as a deliberate family whose evidence covers every runtime-resolved resource, rather than a single forgotten route. Purely declarative - it does not change dispatch.

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
- 1522d06: Path params can now be validated + coerced at the boundary, and query scalars have a coercing constructor - closing the two input slots that lagged behind `body`.

  - **`params` schema slot.** A route (or contract op) can declare `params: t.object({ id: t.string({ format: "uuid" }) })`; a malformed `:id` is now a `422` before the handler runs, exactly like `body`/`query`, instead of an in-handler hand-check. The validated value lands on `c.params` with the schema's output type (a `params` schema can also coerce - use `t.query({ id: t.integer() })` for a numeric path param, and `c.params.id` is a real `number`). Routes without a `params` schema are unchanged: `c.params` stays the path-inferred `Record<name, string>`. The `onValidationError` hook's `kind` gains `"params"`, and params validate first (before body/query). The client's param-call signature is unchanged - a URL segment is still passed as a string.
  - **`t.query(shape)`.** The query-slot analogue of `t.object`, with string->scalar coercion on. Query values always arrive as strings (`?limit=20` -> `"20"`), so a plain `t.object({ limit: t.integer() })` in a `query` slot never validates; `t.query` makes `t.integer()`/`t.number()`/`t.boolean()` fields real numbers/booleans in `c.query`. Open by default (unknown fields such as tracking params are accepted); pass `{ additionalProperties: false }` to enforce a strict allowlist. `t.object` stays the body-slot constructor (a JSON body is already typed - no coercion).

- a7b1d60: WebSocket routes join the end-to-end type chain, and client failures discriminate by status.

  - `app.ws()` now enters the type-level registry (pseudo-method `"WS"`). The typed client grows a
    `.ws()` handle per WS route: `send()` accepts the route's `messageSchema` input type, received
    frames are typed from the new `sendSchema` option (an outbound, type-level contract), and both
    fall back to `unknown` when undeclared. The handle queues sends until open, exposes
    `messages()` (async iteration), `onMessage()`, `opened`, `close()`, and `raw`. Params, path
    literals, and `client<App>` inference work exactly like HTTP routes. Calling `.ws()` on the
    in-process client throws with an explanation (an in-process app has no socket to upgrade).
  - The client's `Result` failure union is now DISCRIMINATED BY STATUS when a route declares an
    `errors` record: `res.status === 404` narrows `res.data` to the declared 404 body. Undeclared
    statuses (and `0` for transport errors) fall into a fallback arm whose `data` is `unknown`;
    routes with no `errors` contract keep the single `unknown` failure arm. Contract operations'
    non-2xx `responses` discriminate the same way. Breaking for type-level consumers only: code that
    read the failure `data` after checking just `ok` must also narrow on `status` (the runtime shape
    is unchanged).
  - `testClient(app, { validateResponses: true })` asserts every JSON response against the route's
    declared contract - `response` for 2xx, `errors[status]` for declared failures - and throws a
    `ResponseContractViolation` on mismatch, so a handler whose real output drifts from its schema
    fails the test instead of passing silently. Off by default; statuses with no declared schema,
    non-JSON bodies, and 204/205/HEAD pass through unchecked.

## 1.13.0

### Minor Changes

- aae8614: `implement(contract, handlers, app)` accepts a pre-configured app, so a contract-first backend can run
  middleware. A route captures the server's `derive`/`decorate`/assurance chain at registration, so the
  chain has to be on the app before its routes exist:

  ```ts
  const app = implement(
    contract,
    handlers,
    server().use(auth).derive(sessionOf)
  );
  ```

  Handlers now receive `Context & Ctx` - the same shape an inline handler gets, so one graduates either
  way unchanged - and any routes already on the app stay in the returned server's registry. This is also
  what lets `nifra assure` prove a contract-first app rather than only classify it: the plugin that
  installs the enforcement is what declares the evidence, and only a plugin installed before
  registration is captured. The two-argument call is unchanged.

- 5b6127a: Make route batches atomic, seal server configuration after `listen()`, encode array query values as
  repeated keys, and align web route matching with the server.

  Three behavior changes to know about:

  - **Configuring a server after `listen()` now throws** instead of reaching some traffic and not the
    rest. Bun's native route table is compiled when you listen, so a hook added afterwards applied to
    `app.fetch()` but not to real HTTP requests: an `onRequest` guard installed late was silently
    skipped on the wire. Register routes, hooks, plugins, and context before listening.
  - **Array query values serialize as repeated keys** (`?tag=a&tag=b`), not `?tag=a%2Cb`, so a route
    whose `query` schema declares an array now receives one.
  - **The web matcher applies the server's trailing-slash rule.** `/users/7/` no longer matches
    `/users/:id` in the browser, matching the 404 the server already returns, and a malformed percent
    encoding reports no route instead of throwing.

  A route batch from `implement()` or `merge()` commits only once every route in it validates, so a
  collision partway through leaves matching and reflection untouched instead of stranding the routes
  registered before it.

  Each route now owns one immutable compiled execution plan shared by portable, Node-direct, and
  Bun-native dispatch. This also fixes validation recovery being skipped when a derive moved a route
  from a specialized lane to the generic lifecycle.

  Core, browser navigation, Bun-native parameter metadata, and mock routing now consume the same
  compiled pattern kernel. Static routes beat parameters and parameters beat wildcards regardless of
  manifest order, with one grammar, trailing-slash policy, and malformed-encoding rule.

## 1.12.0

### Minor Changes

- 63d3845: Add bounded execution-causality contracts and propagation, OpenTelemetry causal links, event-envelope lineage, and a deterministic durable failure laboratory. `nifra levels` L4 now uses the deep adversarial contract engine through its explicitly isolated executor. Also add hash-verifiable adapter certification profiles and duplicate physical Nifra/React install detection in `nifra doctor`/`nifra check`.
- 246f498: `app.listen(port, { hostname })` selects the bind address. It defaults to every interface, as before;
  pass `"127.0.0.1"` to bind loopback only for an admin surface, a sidecar, or any app that must not be
  reachable off the box.

## 1.11.0

### Minor Changes

- 2dde7e5: Add the effect ledger, sandboxed contract-generated invariant tests, and the verification ladder.

  **Effect ledger** - a per-request, append-only, ordered record of side-effect intents and outcomes.
  Routes that declare `schema.capabilities` get a bounded, token-only ledger when the server enables
  `server({ effectLedger })`; each `useCapability(c, id, { target, cost, digest })` beacon
  records an intent, `recordCapabilityOutcome` records its terminal result without double-debiting
  admission, and the sink receives the sealed ledger when the response settles - on success and
  error responses alike, so partial work is audited. Entries carry capability ids, phases, adapter
  tokens, dimensionless cost counters, an optional keyed-HMAC payload digest, and bounded error codes;
  the entry type has no payload field, and the sealed ledger names the route _pattern_ plus the declared
  capability set, never the concrete URL - redaction holds by construction. Includes an optional
  tamper-evident hash chain, a bounded in-memory sink,
  and `computeEffectDigest` (keyed HMAC-SHA-256, so low-entropy data cannot be brute-forced from a
  stored digest). The hash chain binds route identity, declarations, timestamps, and entries. Sink
  failures are logged without their potentially-sensitive message and do not turn a successful effect
  into a retryable 500; transactional audit belongs in the effect's owning transaction. Routes without
  capability declarations keep the existing fast path unchanged.

  **Contract-generated invariant tests** - `runContractInvariants(app, { executor })` fuzzes each route from its
  declared JSON Schema with a deterministic seeded generator and verifies what the contract promises:
  valid inputs never crash, 2xx responses conform to the declared response schema, schema-violating
  bodies are rejected (never accepted, never a crash), and a route-level classification never
  understates its field-level tags. Findings carry the case seed for exact reproduction; ungeneratable
  routes are reported as skipped, never silently dropped.
  Dynamic execution requires an explicit `invariants.executor` backed by a disposable app/sandbox;
  verification never invokes a live app implicitly, and any skipped route prevents L4.

  **Verification ladder** - `nifra levels` computes L0 typed contract → L1 route assurance → L2
  capability lockfile → L3 route manifest → L4 invariant-tested from the existing gates. Levels are
  cumulative and computed, never self-declared; `--min <n>` gates CI on a required floor.

- 279f80c: Harden the idempotency primitive and add field-level response classification.

  Idempotency now requires a server-resolved namespace (a static string for explicitly shared/public
  responses or a `(request, platform) => string` principal resolver - never a raw client identity).
  Routes carrying authenticated assurance must use the resolver form, so the same client key cannot
  collide across principals. Stored and legacy responses cannot replay `Set-Cookie`, authentication
  state, or hop-by-hop headers. `begin` returns an opaque reservation token that `complete`/`abandon` must
  present, so an expired-and-re-reserved key can no longer be overwritten by an older in-flight request.
  Stored responses are captured under a byte bound (`maxResponseBytes`, throwing
  `IdempotencyResponseTooLargeError`), fingerprints canonicalize JSON bodies and bind the content type,
  and a store advertises an honest `durability` marker - a route declaring `scope: "durable"` is rejected
  at registration unless its store is durable. SSE routes cannot be idempotent.

  `classified(schema, tag)` attaches field-level sensitivity that survives composition through nested
  objects, arrays, and unions; reflection exposes both the JSON-pointer field tags and the maximum
  (`public` | `pii` | `secret`). Route-level `schema.classification` remains the fallback, and the
  capability lockfile continues to record the maximum.

- 5638ada: Add an explicit symbol-keyed in-process backend mount interface. `inProcessClient` implements the
  interface and `createWebApp` forwards the outer request's platform context through it, so an
  auto-mounted backend receives the same Workers `env` bindings and `waitUntil` lifetime as the web app.

  The released `.fetch(url, init)` duck-typed mount remains as a compatibility fallback for custom
  bridges. `Server.onRequest` now receives the optional platform object as its second argument.

- 279f80c: Add a deterministic versioned Nifra manifest that joins route schemas, assurance evidence,
  capabilities, and field-level response classification in one hash-verified artifact. Manifests can be
  signed through an operator-provided Ed25519 KMS/HSM callback; Nifra never handles private keys.

  `nifra manifest emit` refuses failing assurance and writes byte-stable output, while
  `nifra manifest diff <before> <after>` hash-verifies both artifacts and fails deployment promotion on
  breaking contract, lost assurance, expanded effects, or increased data sensitivity.

## 1.10.0

### Minor Changes

- 92181be: Add hardened effect and capability assurance: reflected route declarations, fail-closed runtime
  beacons, static effect-provenance analysis, deterministic capability lockfiles, HTTP safe-method
  guards, and effect-specific request or durable idempotency requirements.

  Add `nifra capabilities snapshot` and `nifra capabilities check` so capability drift and raw
  provider bypasses can be enforced in CI without adding work to the default request path.

- 3773f0a: Add a request idempotency primitive and response data-classification tags.

  `schema.idempotency` dedupes retries of a mutating route on an `Idempotency-Key` header: the first
  request runs and its response is stored, a retry with the same key replays that response without
  re-running the handler, a key reused with a different body is rejected (409), a missing key fails
  closed (400), and only successful responses are cached (an error releases the key so a retry can
  proceed). Ships an in-memory `IdempotencyStore` with an injectable clock; a durable store implements
  the same interface. Declaring idempotency also satisfies the capability-assurance idempotency
  requirement for a write capability (`durable` scope additionally clears the durable-command
  requirement). Routes without it keep the existing hot path unchanged.

  `schema.classification` declares the highest data-sensitivity a route's response carries
  (`public` | `pii` | `secret`) - a declarative, compile-time + introspection fact, never enforced at
  runtime. It is reflected for tooling and recorded in the capability lockfile, so a route that starts
  returning PII becomes a reviewable change.

### Patch Changes

- 92181be: Move request-deadline mechanics to the dependency-free `@nifrajs/core/budget` subpath while keeping
  `@nifrajs/budget` as a compatible re-export. Harden adaptive admission across ESM runtimes, reserved
  capacity, disconnected queued requests, and invalid capacity evidence.

## 1.9.1

### Patch Changes

- @nifrajs/budget@1.9.1

## 1.9.0

### Minor Changes

- 03cd76f: Add portable absolute request deadlines with monotonic remaining time, child reserves, strict wire
  parsing, and local-policy admission. Nifra handlers now receive the admitted budget as `c.budget`; it
  shares the existing `c.signal`, clamps hostile far-future deadlines, and distinguishes malformed,
  expired, and exhausted inherited deadlines.

### Patch Changes

- 03cd76f: Compile eligible Nifra routes into Bun's native route table while preserving the existing lifecycle
  and portable-router fallback. Reuse unbounded request state, avoid wall-clock admission work when no
  deadline exists, lazily parse native-route queries, and inspect only captured parameter values.
  Inbound wire deadlines are now an explicit trust-boundary opt-in, keeping ordinary public routes on
  the zero-admission fast path while preserving clamped, fail-closed propagation for participating
  services.
- Updated dependencies [03cd76f]
- Updated dependencies [03cd76f]
  - @nifrajs/budget@1.9.0

## 1.8.0

### Minor Changes

- e47c4c5: Add reflection-time route assurance: middleware and plugins can publish lifecycle-accurate enforcement
  evidence, ordered policies fail closed on unclassified/missing/forbidden evidence, official hardening
  middleware emits canonical evidence, and `nifra assure` exposes a human/JSON CI gate.

## 1.7.0

### Minor Changes

- bd95181: `app.merge(group)` - domain-group composition for large apps, and the documented answer to the ~95-route TS2589 ceiling. A single fluent chain accumulates one type-alias level per route and TypeScript resolves that stack in one recursion, so one chain hits the compiler's instantiation-depth limit at ~95-100 routes (measured; eager-flattening variants all fail - see registry.ts). Build each domain as its own `server()` (its registry resolves independently) and merge: `app.merge(listings).merge(agents)` - each merge adds one level regardless of group size; 120+ routes typecheck with full param/schema fidelity (pinned in many-routes.test-d.ts). Merged routes keep the chains captured where they were defined (the group's own derive/validation/hooks apply exactly as standalone); the group's request-level hooks append to the parent; collisions and WebSocket groups fail closed at merge time. Contract-first `implement()` remains the other supported path - its registry is a single object type with no accumulation at all.

## 1.6.0

## 1.5.0

### Minor Changes

- 1ac2fde: API breaking-change gate: `snapshotRoutes` + `diffRouteSnapshots` in `@nifrajs/core/diff` (direction-aware - a new required request field or a removed response field breaks; widening a request enum or adding a response field doesn't; fails closed on anything unprovable), and `nifra snapshot` / `nifra diff <baseline>` CLI commands that exit non-zero on breaking changes for CI.
- bd3433f: Security + correctness hardening: `FileStorage` refuses paths that cross symbolic links (component-wise `lstat` walk + `O_NOFOLLOW` writes; `list()` skips symlinks) so a planted symlink can no longer redirect reads/writes outside the storage root. OTel spans no longer copy raw `Error.message` into exported attributes (exception text routinely carries credentials/URLs); spans record `error.recorded: true` instead. New `onResponseFinalized` terminal observer on the server (`Middleware.onResponseFinalized` / `ResponseFinalization`) runs after every transforming `onResponse` hook and is fail-open - tracing now records the true final status even when a later hook rewrites or throws. OpenAPI generation sanitizes URI-style `$id` values into valid component names/`$ref` pointers (hex-derived, collision-suffixed) and is immune to `__proto__` key pollution.
- 70aa836: End-to-end typed SSE subscriptions. `app.sse(path, { sse: t.object(...) }, (c, stream) => ...)` declares a typed event-stream route: the handler's `stream.send(event)` is compile-time-checked against the schema (JSON-serialized into the SSE `data:` field), the schema flows into the type-level contract and reflection, and query/body validation works exactly as on any route. The typed client grows `.subscribe(onEvent, options?)` on those routes - the event payload is inferred from the backend contract, transport is fetch-based (works over the network client, `inProcessClient`, and `testClient` alike) with EventSource semantics where they matter: auto-reconnect with backoff + jitter honoring the server's `retry:` hint, `Last-Event-ID` resumption, `reconnect: false` for finite streams, `onError`/`onClose` hooks, and an `AbortSignal`. Ordinary routes do not grow a `subscribe` key (type-level tested).

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

## 1.3.1

## 1.3.0

### Minor Changes

- 4a4b1c4: feat(core): app-wide default `onValidationError` + `kind` argument

  `server({ onValidationError })` now sets an app-wide fallback that fires when a route **without its own**
  `onValidationError` fails body/query validation - one place to define your error envelope instead of repeating
  it per route (like tRPC's `errorFormatter` / Fastify's `setErrorHandler`), while a route's own hook still
  takes precedence. A route can fall through to the plain `422` by returning `undefined`.

  The hook (route-level and app-level) now also receives a third argument, `kind: "body" | "query"`, telling it
  which input failed - backward-compatible (existing 2-arg hooks are unaffected). The healed-value re-validation
  contract is unchanged: an app-level default that returns a repaired value is re-validated against the route's
  schema before the handler runs.

- 4a4b1c4: feat: `server().resource()` / `.prompt()` - app-declared MCP resources & prompts

  Completing the MCP trio alongside `.tool()`: an app can now expose its own MCP **resources**
  (`.resource(uri, { name, description?, mimeType? }, read)`) and **prompts** (`.prompt(name, { description,
arguments? }, handler)`). `nifra mcp` surfaces them in `resources/list` + `resources/read` and `prompts/list`

  - `prompts/get` (namespaced per app in a monorepo). The `read`/`handler` closures run in the app process, so
    they capture whatever app state they need - no HTTP round-trip.

- 4a4b1c4: feat: MCP tool annotations on `server().tool()`

  `.tool()` config now accepts `annotations` - the MCP spec's per-tool safety hints (`title`, `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) - surfaced in `tools/list` and `tools/describe`. An
  agent can now tell a read-only tool from a destructive one and decide whether to auto-invoke or confirm
  first, instead of treating every exposed tool as equally risky.

- 4a4b1c4: feat: `errors` response contract on routes + typed client error bodies

  A route's `RouteSchema` may now declare `errors` - a `{ status → Standard Schema }` map of its failure modes.
  Like `response`, it's a compile-time + introspection contract (not validated at runtime, zero hot-path cost):
  the declared error bodies flow into OpenAPI as non-2xx `responses` and into the `/llms.txt` context, so
  tooling and coding agents can read the _whole_ contract, not just the happy path.

  The **typed client** now surfaces them: on a failure `Result`, `data` is the parsed error body typed from the
  route's `errors` (a union across declared statuses; `unknown` when none declared), discriminated by `ok`.
  `error` remains the normalized `{ error, issues }` summary. The **decoupled contract client**
  (`client(contract, url)`) gets the same treatment - its failure `data` is typed from the op's non-2xx
  `responses` schemas.

  **Behavior change:** on failure, `data` is now the parsed error response body (previously always `null`) - so
  `const { ok, data } = await api.orders.post(...)` gives you the typed error body in the `!ok` branch. `data`
  is still `null` only on a transport error (status `0`, no response).

- 4a4b1c4: feat(core): `onValidationError` route hook + `server().tool()`

  Two additions for building agent-facing endpoints on Nifra:

  - **`onValidationError` route hook**: a `RouteSchema` callback that runs when a request fails schema
    validation. It receives the Standard Schema issues and the request context, and may return a `Response`
    (short-circuit the route), a repaired payload (re-validated before dispatch - still invalid → the original
    `422` stands), or `undefined` (keep the `422`). Makes validation recovery pluggable instead of every
    handler re-checking by hand.

  - **`server().tool(name, config, handler)`**: register a `.tool()` route (`POST /_nifra/tool/:name`) with
    typed `input`/`output` Standard Schemas. The handler's `input` is inferred from the input schema; the
    descriptor is tagged as an MCP tool so `nifra mcp` exposes it in `tools/list`.

## 1.2.2

## 1.2.1

## 1.2.0

### Minor Changes

- 0ac2182: feat(core): validation failures now return **422**, plus a params-decode fast path

  **Behavior change:** a request that fails a route's `body`/`query` schema validation is now rejected
  with **`422 Unprocessable Entity`** (previously `400`). The response body shape is unchanged
  (`{ ok: false, error: "validation", issues }`). If your client branches on `status === 400` for
  validation failures, switch it to `422`. Genuinely malformed requests keep their existing codes -
  invalid JSON via `boundedJson` and an undecodable path are still `400`.

  Also: route params skip the `decodeURIComponent` pass entirely when the pathname contains no `%`
  (the overwhelmingly common case) - same behavior, less per-request work, on both the HTTP and
  WebSocket-upgrade paths.

## 1.1.0

## 1.0.0

### Minor Changes

- f1f0e18: Context ergonomics, from beta feedback building on Nifra.

  - **`c.json(body, status?)` / `c.text(body, status?)`** - build a `Response` in one line; the second arg is a status number or a full `ResponseInit`, and it works whether you `return` or `throw` it. Ideal for an auth / rate-limit short-circuit from a `derive`/`beforeHandle`: `throw c.json({ error: "unauthorized" }, 401)` instead of `new Response(JSON.stringify(…), { status: 401, headers: … })`. (In a route's happy path keep returning a plain object so the typed client stays in sync.) Added as prototype methods - no per-request allocation.
  - **One name for the request across routes and loaders.** A route handler's `c.req` is now also `c.request`, and a page loader/action's `ctx.request` is now also `ctx.req` - fixing the `c.req`-vs-`ctx.request` mismatch that was easy to trip over.

  Docs: the API page documents `c.json`/`c.text` + the request alias; a new troubleshooting entry covers a `never` typed client (raw-`Response` return, or a non-identity plugin → `defineIdentityPlugin`).

- 3efb7cd: Sharper types + names for two footguns hit building on Nifra.

  - **`defineRouterPlugin`** - a clearer-named alias of `defineIdentityPlugin` for a plugin that mounts routes/hooks but adds **no context type** (an auth router, an audit logger). `definePlugin`'s docs now loudly warn that using it for such a plugin silently collapses the typed client to `any` (no type error, no runtime error). The plugins guide leads with `defineRouterPlugin` and shows the side-effect-then-`return app` mount pattern.
  - **Better error when a route has no `query` schema.** Passing `query` to such a route via the typed client now fails with a message that reads out the fix - `add a \`query\` schema to this route - { query: z.object({ … }) } - so the typed client can accept query params here`- instead of the opaque`not assignable to type 'never'`. The error surfaces at the call site; the fix is at the route. Non-breaking: passing query to a schema-less route was already rejected, just unhelpfully.

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
