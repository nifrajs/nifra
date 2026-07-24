# @nifrajs/core

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
