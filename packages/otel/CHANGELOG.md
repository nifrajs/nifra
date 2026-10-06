# @nifrajs/otel

## 4.0.1

## 4.0.0

### Minor Changes

- ac703a1: `cacheTracing()` from `@nifrajs/otel/cache` turns `@nifrajs/cache` operations into spans.

  - Pass it as `createCache({ observer: cacheTracing({ exporter }) })`. Every operation on a view bound with `cache.for(c)` becomes a `cache <op>` child span of `c.trace`, with `nifra.cache.operation`, `nifra.cache.outcome` and `nifra.cache.tag_count`.
  - Raw keys stay in the process. By default a span carries only the key prefix (`user:42` gives `nifra.cache.key_prefix = "user"`); `keyAttribute: "none"` drops it and a function exports its own value.
  - The background refresh of a stale `wrap` is a `cache revalidate` span in its own trace, linked to the request span.
  - `StartObservation.startTime` and `EndObservation.durationMs` record work after it settled.

- e1b89c0: `traceEventConsumer()` from `@nifrajs/otel/events` traces an `@nifrajs/events` consumer with one wrapper.

  - `traceEventConsumer(contractOrRegistry, handler, { exporter })` returns `consume(input, parent?)`. Each envelope is one `process <type>` consumer span, linked to the producer's span through `causalitySpanLink(envelope.causality)`; with a `parent` trace (a webhook route's `c.trace`) the span is its child.
  - Attributes: `nifra.event.type`, `nifra.event.version`, `messaging.message.id` (the envelope id), `messaging.operation.type`/`.name` = `process`, and `messaging.system` (`system` option, default `"nifra.events"`).
  - Input that fails to parse never reaches the handler: it resolves `{ success: false, issueCount }` and records an error span carrying the issue count and, for a registry, its bounded reason. No payload is exported.
  - The handler receives `{ trace }` for nested spans, and `scope` runs it inside an ambient context.

- 1afbe9f: `jobTracing()` from `@nifrajs/otel/jobs` traces `@nifrajs/jobs` with OpenTelemetry messaging spans.

  - Pass it as `createQueue({ instrument: jobTracing({ exporter }) })`.
  - Each enqueue is a `send <job>` producer span (a child of `c.trace` when enqueued through `job.for(c)`), and its context is stored with the job.
  - Each attempt is a `process <job>` consumer span: a child of the send span, plus a link to it. Retries are separate spans; a failed attempt is an error span, and the one that dead-letters the job carries `nifra.job.dead_lettered = true`.
  - Attributes: `messaging.system = "nifra.jobs"`, `messaging.operation.type`, `messaging.operation.name`, `messaging.destination.name`, `messaging.message.id`, `nifra.job.attempt`, `nifra.job.outcome`. Error text is never exported.
  - A malformed stored traceparent starts a new trace; the sampled flag travels with a valid one.
  - `scope` runs each attempt inside an ambient context, such as the OpenTelemetry SDK's.

- b8af5cf: `otelBridge()` from `@nifrajs/otel/sdk-bridge` connects nifra spans to the OpenTelemetry SDK. The app passes its own `@opentelemetry/api`; `@nifrajs/otel` adds no dependency.

  - `bridge.plugin`: `app.use(bridge.plugin)` runs each subsequent route with its request span active in the OTel context, so the SDK's own instrumentations (pg, mysql2, ioredis, undici, prisma) nest under the request span. It costs one `around()` frame per request, only when installed.
  - `bridge.adapter`: mirrors nifra spans into SDK spans (name, kind, parent, links, attributes, status, timing). Pass it in `tracing({ adapters })` and the other tracers' `adapters`.
  - `bridge.idGenerator`: wired as the SDK provider's `idGenerator`, mirrored spans keep nifra's exact trace and span ids, so forwarded `traceparent` headers and the trace context stored with a job name real spans. Without it the adapter warns once.
  - `bridge.scope`: runs code with a nifra span active in the OTel context; pass it as `jobTracing({ scope })` or `traceEventConsumer(..., { scope })` so spans inside a job or event handler nest under it.
  - Context propagation needs the SDK's AsyncLocalStorage context manager. Verified on Node 26, Bun 1.4, Deno 2.9 and workerd with `nodejs_compat`. The SDK's undici instrumentation records `fetch` only on Node, where `fetch` is undici.

- 6d87951: Spans carry an OpenTelemetry span kind.

  - `NifraSpan.kind` and `StartObservation.kind` take `"server" | "client" | "producer" | "consumer" | "internal"`.
  - `otlpExporter()` sends each kind as its OTLP enum value. A span without a kind is sent as `SERVER`.
  - `tracing()` request spans are `server` spans; `effectTracing()` capability spans are `internal` spans.
  - `consoleSpanExporter()` logs the kind when a span has one.

### Patch Changes

- 1b2d53a: `replacedRequestOf(request)` returns the request an `onRequest` hook replaced with this one. Response hooks receive the request the route ran with, so a middleware that keyed state on the request its `onRequest` saw can walk back to it. `idempotency()` uses this to keep its claim when a later hook such as `methodOverride()` rewrites the request: a retry replays the stored response instead of answering 409 and then running the handler a second time. `metrics()` uses it to count such requests and to decrement its in-flight gauge for them.
- 50e68d9: `metrics()` labels a request method outside HTTP's standard set as `_OTHER`, following OpenTelemetry's HTTP conventions. A runtime that accepts extension methods, such as Deno, can no longer be made to create a new series per request.
- 76b7aa8: `tracing()` names a request span `{method} {route template}` - `GET /users/:id`, not `GET /users/42` - and records the template as `http.route`, as OpenTelemetry's HTTP conventions describe. The raw path stays in `url.path`. A method outside HTTP's own set is recorded as `_OTHER`, with the original in `http.request.method_original`.
- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

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

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

### Minor Changes

- 0efacea: Add a generic server `onStop` lifecycle hook and have OTLP tracing exporters flush and shut down automatically when attached to a server. Manual OTLP lifecycle calls remain available for standalone exporters.
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

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

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

### Minor Changes

- bc46cc9: Production observability: a batching OTLP span exporter and RED metrics.

  - `otlpExporter({ url, headers?, batch?, onError? })` ships spans to any OpenTelemetry collector over OTLP/HTTP (JSON) with in-process batching - dependency-free and edge-safe, matching the package's no-SDK stance. `tracing({ exporter: otlpExporter({ url: "http://localhost:4318/v1/traces" }) })` is now production-usable without writing your own exporter. `flush()`/`shutdown()` drain on graceful stop.
  - `.use(metrics())` from `@nifrajs/otel/metrics` records RED metrics - `nifra_http_requests_total`, `nifra_http_request_duration_seconds`, `nifra_http_requests_in_flight` - labeled by method, the matched route TEMPLATE (so `/users/:id` is one series, not one per id), and status, and exposes them in Prometheus text at `/metrics`. `createMetricsRegistry()` lets an app register custom counters/gauges/histograms that render at the same endpoint. Zero dependencies; the subpath keeps it out of tracing-only bundles.

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

## 1.13.0

## 1.12.0

### Minor Changes

- 63d3845: Add bounded execution-causality contracts and propagation, OpenTelemetry causal links, event-envelope lineage, and a deterministic durable failure laboratory. `nifra levels` L4 now uses the deep adversarial contract engine through its explicitly isolated executor. Also add hash-verifiable adapter certification profiles and duplicate physical Nifra/React install detection in `nifra doctor`/`nifra check`.

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

### Minor Changes

- d228ac4: `ActiveObservation.setAttributes(attributes)` - merge attributes onto the in-flight request span from a handler or later plugin (`c.observation.setAttributes({ "tenant.key": ... })`), for facts learned mid-request (authenticated principal, flag bucket, cache verdict). Silently a no-op once the observation has ended; the exported span stays immutable.

## 1.5.0

### Patch Changes

- bd3433f: Security + correctness hardening: `FileStorage` refuses paths that cross symbolic links (component-wise `lstat` walk + `O_NOFOLLOW` writes; `list()` skips symlinks) so a planted symlink can no longer redirect reads/writes outside the storage root. OTel spans no longer copy raw `Error.message` into exported attributes (exception text routinely carries credentials/URLs); spans record `error.recorded: true` instead. New `onResponseFinalized` terminal observer on the server (`Middleware.onResponseFinalized` / `ResponseFinalization`) runs after every transforming `onResponse` hook and is fail-open - tracing now records the true final status even when a later hook rewrites or throws. OpenAPI generation sanitizes URI-style `$id` values into valid component names/`$ref` pointers (hex-derived, collision-suffixed) and is immune to `__proto__` key pollution.

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/core@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/core@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/core@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- @nifrajs/core@0.1.0-beta.2
