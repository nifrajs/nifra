# @nifrajs/core

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

  Handlers now receive `Context & Ctx` — the same shape an inline handler gets, so one graduates either
  way unchanged — and any routes already on the app stay in the returned server's registry. This is also
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

  **Effect ledger** — a per-request, append-only, ordered record of side-effect intents and outcomes.
  Routes that declare `schema.capabilities` get a bounded, token-only ledger when the server enables
  `server({ effectLedger })`; each `useCapability(c, id, { target, cost, digest })` beacon
  records an intent, `recordCapabilityOutcome` records its terminal result without double-debiting
  admission, and the sink receives the sealed ledger when the response settles — on success and
  error responses alike, so partial work is audited. Entries carry capability ids, phases, adapter
  tokens, dimensionless cost counters, an optional keyed-HMAC payload digest, and bounded error codes;
  the entry type has no payload field, and the sealed ledger names the route _pattern_ plus the declared
  capability set, never the concrete URL — redaction holds by construction. Includes an optional
  tamper-evident hash chain, a bounded in-memory sink,
  and `computeEffectDigest` (keyed HMAC-SHA-256, so low-entropy data cannot be brute-forced from a
  stored digest). The hash chain binds route identity, declarations, timestamps, and entries. Sink
  failures are logged without their potentially-sensitive message and do not turn a successful effect
  into a retryable 500; transactional audit belongs in the effect's owning transaction. Routes without
  capability declarations keep the existing fast path unchanged.

  **Contract-generated invariant tests** — `runContractInvariants(app, { executor })` fuzzes each route from its
  declared JSON Schema with a deterministic seeded generator and verifies what the contract promises:
  valid inputs never crash, 2xx responses conform to the declared response schema, schema-violating
  bodies are rejected (never accepted, never a crash), and a route-level classification never
  understates its field-level tags. Findings carry the case seed for exact reproduction; ungeneratable
  routes are reported as skipped, never silently dropped.
  Dynamic execution requires an explicit `invariants.executor` backed by a disposable app/sandbox;
  verification never invokes a live app implicitly, and any skipped route prevents L4.

  **Verification ladder** — `nifra levels` computes L0 typed contract → L1 route assurance → L2
  capability lockfile → L3 route manifest → L4 invariant-tested from the existing gates. Levels are
  cumulative and computed, never self-declared; `--min <n>` gates CI on a required floor.

- 279f80c: Harden the idempotency primitive and add field-level response classification.

  Idempotency now requires a server-resolved namespace (a static string for explicitly shared/public
  responses or a `(request, platform) => string` principal resolver — never a raw client identity).
  Routes carrying authenticated assurance must use the resolver form, so the same client key cannot
  collide across principals. Stored and legacy responses cannot replay `Set-Cookie`, authentication
  state, or hop-by-hop headers. `begin` returns an opaque reservation token that `complete`/`abandon` must
  present, so an expired-and-re-reserved key can no longer be overwritten by an older in-flight request.
  Stored responses are captured under a byte bound (`maxResponseBytes`, throwing
  `IdempotencyResponseTooLargeError`), fingerprints canonicalize JSON bodies and bind the content type,
  and a store advertises an honest `durability` marker — a route declaring `scope: "durable"` is rejected
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
  (`public` | `pii` | `secret`) — a declarative, compile-time + introspection fact, never enforced at
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

- bd95181: `app.merge(group)` — domain-group composition for large apps, and the documented answer to the ~95-route TS2589 ceiling. A single fluent chain accumulates one type-alias level per route and TypeScript resolves that stack in one recursion, so one chain hits the compiler's instantiation-depth limit at ~95-100 routes (measured; eager-flattening variants all fail — see registry.ts). Build each domain as its own `server()` (its registry resolves independently) and merge: `app.merge(listings).merge(agents)` — each merge adds one level regardless of group size; 120+ routes typecheck with full param/schema fidelity (pinned in many-routes.test-d.ts). Merged routes keep the chains captured where they were defined (the group's own derive/validation/hooks apply exactly as standalone); the group's request-level hooks append to the parent; collisions and WebSocket groups fail closed at merge time. Contract-first `implement()` remains the other supported path — its registry is a single object type with no accumulation at all.

## 1.6.0

## 1.5.0

### Minor Changes

- 1ac2fde: API breaking-change gate: `snapshotRoutes` + `diffRouteSnapshots` in `@nifrajs/core/diff` (direction-aware — a new required request field or a removed response field breaks; widening a request enum or adding a response field doesn't; fails closed on anything unprovable), and `nifra snapshot` / `nifra diff <baseline>` CLI commands that exit non-zero on breaking changes for CI.
- bd3433f: Security + correctness hardening: `FileStorage` refuses paths that cross symbolic links (component-wise `lstat` walk + `O_NOFOLLOW` writes; `list()` skips symlinks) so a planted symlink can no longer redirect reads/writes outside the storage root. OTel spans no longer copy raw `Error.message` into exported attributes (exception text routinely carries credentials/URLs); spans record `error.recorded: true` instead. New `onResponseFinalized` terminal observer on the server (`Middleware.onResponseFinalized` / `ResponseFinalization`) runs after every transforming `onResponse` hook and is fail-open — tracing now records the true final status even when a later hook rewrites or throws. OpenAPI generation sanitizes URI-style `$id` values into valid component names/`$ref` pointers (hex-derived, collision-suffixed) and is immune to `__proto__` key pollution.
- 70aa836: End-to-end typed SSE subscriptions. `app.sse(path, { sse: t.object(...) }, (c, stream) => ...)` declares a typed event-stream route: the handler's `stream.send(event)` is compile-time-checked against the schema (JSON-serialized into the SSE `data:` field), the schema flows into the type-level contract and reflection, and query/body validation works exactly as on any route. The typed client grows `.subscribe(onEvent, options?)` on those routes — the event payload is inferred from the backend contract, transport is fetch-based (works over the network client, `inProcessClient`, and `testClient` alike) with EventSource semantics where they matter: auto-reconnect with backoff + jitter honoring the server's `retry:` hint, `Last-Event-ID` resumption, `reconnect: false` for finite streams, `onError`/`onClose` hooks, and an `AbortSignal`. Ordinary routes do not grow a `subscribe` key (type-level tested).

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

## 1.3.1

## 1.3.0

### Minor Changes

- 4a4b1c4: feat(core): app-wide default `onValidationError` + `kind` argument

  `server({ onValidationError })` now sets an app-wide fallback that fires when a route **without its own**
  `onValidationError` fails body/query validation — one place to define your error envelope instead of repeating
  it per route (like tRPC's `errorFormatter` / Fastify's `setErrorHandler`), while a route's own hook still
  takes precedence. A route can fall through to the plain `422` by returning `undefined`.

  The hook (route-level and app-level) now also receives a third argument, `kind: "body" | "query"`, telling it
  which input failed — backward-compatible (existing 2-arg hooks are unaffected). The healed-value re-validation
  contract is unchanged: an app-level default that returns a repaired value is re-validated against the route's
  schema before the handler runs.

- 4a4b1c4: feat: `server().resource()` / `.prompt()` — app-declared MCP resources & prompts

  Completing the MCP trio alongside `.tool()`: an app can now expose its own MCP **resources**
  (`.resource(uri, { name, description?, mimeType? }, read)`) and **prompts** (`.prompt(name, { description,
arguments? }, handler)`). `nifra mcp` surfaces them in `resources/list` + `resources/read` and `prompts/list`

  - `prompts/get` (namespaced per app in a monorepo). The `read`/`handler` closures run in the app process, so
    they capture whatever app state they need — no HTTP round-trip.

- 4a4b1c4: feat: MCP tool annotations on `server().tool()`

  `.tool()` config now accepts `annotations` — the MCP spec's per-tool safety hints (`title`, `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) — surfaced in `tools/list` and `tools/describe`. An
  agent can now tell a read-only tool from a destructive one and decide whether to auto-invoke or confirm
  first, instead of treating every exposed tool as equally risky.

- 4a4b1c4: feat: `errors` response contract on routes + typed client error bodies

  A route's `RouteSchema` may now declare `errors` — a `{ status → Standard Schema }` map of its failure modes.
  Like `response`, it's a compile-time + introspection contract (not validated at runtime, zero hot-path cost):
  the declared error bodies flow into OpenAPI as non-2xx `responses` and into the `/llms.txt` context, so
  tooling and coding agents can read the _whole_ contract, not just the happy path.

  The **typed client** now surfaces them: on a failure `Result`, `data` is the parsed error body typed from the
  route's `errors` (a union across declared statuses; `unknown` when none declared), discriminated by `ok`.
  `error` remains the normalized `{ error, issues }` summary. The **decoupled contract client**
  (`client(contract, url)`) gets the same treatment — its failure `data` is typed from the op's non-2xx
  `responses` schemas.

  **Behavior change:** on failure, `data` is now the parsed error response body (previously always `null`) — so
  `const { ok, data } = await api.orders.post(...)` gives you the typed error body in the `!ok` branch. `data`
  is still `null` only on a transport error (status `0`, no response).

- 4a4b1c4: feat(core): `onValidationError` route hook + `server().tool()`

  Two additions for building agent-facing endpoints on Nifra:

  - **`onValidationError` route hook**: a `RouteSchema` callback that runs when a request fails schema
    validation. It receives the Standard Schema issues and the request context, and may return a `Response`
    (short-circuit the route), a repaired payload (re-validated before dispatch — still invalid → the original
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
  validation failures, switch it to `422`. Genuinely malformed requests keep their existing codes —
  invalid JSON via `boundedJson` and an undecodable path are still `400`.

  Also: route params skip the `decodeURIComponent` pass entirely when the pathname contains no `%`
  (the overwhelmingly common case) — same behavior, less per-request work, on both the HTTP and
  WebSocket-upgrade paths.

## 1.1.0

## 1.0.0

### Minor Changes

- f1f0e18: Context ergonomics, from beta feedback building on Nifra.

  - **`c.json(body, status?)` / `c.text(body, status?)`** — build a `Response` in one line; the second arg is a status number or a full `ResponseInit`, and it works whether you `return` or `throw` it. Ideal for an auth / rate-limit short-circuit from a `derive`/`beforeHandle`: `throw c.json({ error: "unauthorized" }, 401)` instead of `new Response(JSON.stringify(…), { status: 401, headers: … })`. (In a route's happy path keep returning a plain object so the typed client stays in sync.) Added as prototype methods — no per-request allocation.
  - **One name for the request across routes and loaders.** A route handler's `c.req` is now also `c.request`, and a page loader/action's `ctx.request` is now also `ctx.req` — fixing the `c.req`-vs-`ctx.request` mismatch that was easy to trip over.

  Docs: the API page documents `c.json`/`c.text` + the request alias; a new troubleshooting entry covers a `never` typed client (raw-`Response` return, or a non-identity plugin → `defineIdentityPlugin`).

- 3efb7cd: Sharper types + names for two footguns hit building on Nifra.

  - **`defineRouterPlugin`** — a clearer-named alias of `defineIdentityPlugin` for a plugin that mounts routes/hooks but adds **no context type** (an auth router, an audit logger). `definePlugin`'s docs now loudly warn that using it for such a plugin silently collapses the typed client to `any` (no type error, no runtime error). The plugins guide leads with `defineRouterPlugin` and shows the side-effect-then-`return app` mount pattern.
  - **Better error when a route has no `query` schema.** Passing `query` to such a route via the typed client now fails with a message that reads out the fix — `add a \`query\` schema to this route — { query: z.object({ … }) } — so the typed client can accept query params here`— instead of the opaque`not assignable to type 'never'`. The error surfaces at the call site; the fix is at the route. Non-breaking: passing query to a schema-less route was already rejected, just unhelpfully.

- de9675b: Pre-1.0 security hardening pass. A framework-wide audit found no critical/high issues; these close the medium/low items it surfaced.

  - **`cache()` — no cross-user leak by default.** A `200` to a request bearing `Authorization`/`Cookie` is no longer stored (and replayed to other users) unless the response is explicitly `Cache-Control: public`/`s-maxage` (RFC 9111 §3.5). Opt back in per cache with `cacheAuthenticated: true` for a route that's identical for every caller.
  - **`idempotency()` — route-scoped keys + a `key` hook.** The default store key is now scoped by method+path, so the same `Idempotency-Key` on a different endpoint can't collide and replay another resource's response. Added a `key(req, header)` option to scope by principal (e.g. user id). Method matching normalized to upper-case.
  - **`etag()` — a `304` no longer carries the `200`'s `Content-Length`/`Content-Type`.**
  - **`@nifrajs/core` — inbound WebSocket frames are capped** when serving on Bun (`listen()`): frames over `wsMaxPayloadBytes` (default `maxBodyBytes`, 1 MB) are rejected by the runtime before reaching a handler, so a huge frame can't be buffered/parsed into memory. New `ServerOptions.wsMaxPayloadBytes`.
  - **`@nifrajs/core` — WebSocket routes are same-origin by default (CSWSH).** A `ws()` route with no `allowedOrigins` now rejects a **cross-origin browser** handshake (an `Origin` whose host differs from the request's) with `403` — closing cross-site WebSocket hijacking, since browsers send cookies on WS handshakes and don't apply CORS. Non-browser clients (no `Origin`) and same-origin browsers are unaffected. **Breaking** for a route that served a cross-origin browser without declaring `allowedOrigins`: set `allowedOrigins` to the permitted origins (or `() => true` for a genuinely public socket).
  - **`@nifrajs/node` — static file handler** now adds `X-Content-Type-Options: nosniff` and re-checks the real path (symlink containment) before streaming, matching the image server.
  - **`@nifrajs/mcp` — widget bridge** now rejects `postMessage` events whose source isn't the parent window (including null-source synthetic events), closing a spoofing gap the previous guard left open.
  - **`@nifrajs/cli` — the MCP `nifra_run`/`nifra_ws` `entry` arg** is kept inside the project root, so a crafted `entry` can't import/execute a module outside the project.

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2
