# @nifrajs/client

## 2.10.0

## 2.9.1

## 2.9.0

### Patch Changes

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

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

### Minor Changes

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

- c823915: Typed, validated search params: a route declares a `searchSchema` and both its loader and its component read the parsed, validated query.

  Export a Standard Schema as `searchSchema` from a route. The loader's `ctx.search` becomes the parsed URL query validated against it (typed via `LoaderArgs<typeof app, Env, typeof searchSchema>`), and the component reads the same value with `useSearch<typeof searchSchema>()`. Invalid or hostile input fails closed to the schema's defaults (never a 500); without a `searchSchema`, both are the raw parsed query. Validation runs at match time and the value is derived identically on the server and on client navigation, so a component never parses `window.location.search` by hand and the query it renders hydrates with no mismatch.

  ```tsx
  export const searchSchema = v.object({
    page: v.optional(v.fallback(v.number(), 1), 1),
  });

  export async function loader({
    search,
    api,
  }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
    return { rows: await api.reports.list(search).get() }; // search.page is a number
  }

  export default function Reports({ data }) {
    const { page } = useSearch<typeof searchSchema>(); // page: number, SSR-correct
    return <Pager page={page} />;
  }
  ```

  A `_layout` can declare its own `searchSchema` for keys shared across a section (`?org`, `?theme`); the route's effective search merges the layout chain's schemas with the page's, page-wins on a conflict, so both the layout and the page read their validated slice from one object.

  A route can also list `searchClientKeys` - search keys that are purely client-side UI (`?tab`, a client-side `?sort`, `?modal`). When a client navigation changes only those keys, the URL updates (so `useSearch` re-renders) without re-running the loader; any other key change revalidates as before, so data is never stale.

  `useSearch` ships on every adapter - React (a value), Preact (a value), Vue (a `Ref`), Solid (an `Accessor`), and Svelte (an accessor), each in that framework's own shape.

  `navigate` gains an object form on every adapter: `navigate({ to, search, replace })` serializes `search` onto `to` (no hand-built query strings). Run `nifra sync-routes` to generate `nifra-routes.d.ts` (each static route mapped to its schema output) and include it in your tsconfig, and `search` is typed against the target route's `searchSchema` - a wrong shape for a known route is a compile error, while an unmapped path takes a loose `search`. Regenerated from the route files, so a stale shape becomes a `tsc` error. The string-path and history-delta forms are unchanged.

  ```ts
  navigate({ to: "/reports", search: { page: 2 } }); // search typed against /reports's schema
  ```

### Patch Changes

- 9b110b9: A binary response arrives intact, as a `Blob`.

  The client handled JSON and then fell back to `.text()` for everything else. Decoding bytes as UTF-8
  does not fail, it SUBSTITUTES: every invalid sequence becomes U+FFFD, so a PNG came back as a string
  of replacement characters that could not be turned back into the image.

      sent      89 50 4e 47 ff d8
      received  ef bf bd 50 4e 47 ef bf bd ef bf bd

  That is worse than refusing the body, because it reads as a broken file rather than a broken client.

  The media type decides now: JSON decodes as before, text decodes as before, everything else comes back
  as a `Blob` carrying its type. `text/*` is untouched, and so is anything ending `+xml` or `+json` -
  an SVG is a document, and returning one as a `Blob` would break callers reading it as markup. A
  response with no content-type is still parsed as JSON-or-text, which is what a hand-written
  `new Response("…")` produces.

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

- d91a45b: The in-process backend mount is now exclusively the symbol-keyed `BackendMount` interface that `inProcessClient()` / `testClient()` implement.

  `createWebApp({ api })` auto-mounts a backend only through that symbol seam - the platform-aware path that forwards `env` / `waitUntil`. The `.fetch(url, init)` mount convention is gone: an `api` that only exposes a callable `.fetch` is no longer auto-mounted. Backends passed as `inProcessClient(app)` / `testClient(app)` are unaffected, since they carry the symbol mount already.

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

### Minor Changes

- a7b1d60: The typed client gains request/response interceptors, a timeout, and a safe retry policy in `ClientOptions`.

  - `onRequest` runs before each attempt and can return headers to merge - `await`ed, so async auth-token refresh works. `onResponse` observes the final response.
  - `timeoutMs` aborts a slow call, surfacing as `{ ok: false, status: 0 }` with a `timeout` error (never a throw), combined with any per-call `signal`.
  - `retry` enables automatic retries that are safe by construction: only idempotent methods (`GET/HEAD/OPTIONS/PUT/DELETE`) and only transient statuses (`502/503/504` by default) plus network errors are retried, with exponential backoff and jitter. A 4xx/429 and a non-idempotent method are never retried, so a retry can't duplicate a side effect. Off unless configured.

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

### Minor Changes

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

## 1.11.0

### Minor Changes

- 5638ada: Add an explicit symbol-keyed in-process backend mount interface. `inProcessClient` implements the
  interface and `createWebApp` forwards the outer request's platform context through it, so an
  auto-mounted backend receives the same Workers `env` bindings and `waitUntil` lifetime as the web app.

  The released `.fetch(url, init)` duck-typed mount remains as a compatibility fallback for custom
  bridges. `Server.onRequest` now receives the optional platform object as its second argument.

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

### Minor Changes

- 70aa836: End-to-end typed SSE subscriptions. `app.sse(path, { sse: t.object(...) }, (c, stream) => ...)` declares a typed event-stream route: the handler's `stream.send(event)` is compile-time-checked against the schema (JSON-serialized into the SSE `data:` field), the schema flows into the type-level contract and reflection, and query/body validation works exactly as on any route. The typed client grows `.subscribe(onEvent, options?)` on those routes - the event payload is inferred from the backend contract, transport is fetch-based (works over the network client, `inProcessClient`, and `testClient` alike) with EventSource semantics where they matter: auto-reconnect with backoff + jitter honoring the server's `retry:` hint, `Last-Event-ID` resumption, `reconnect: false` for finite streams, `onError`/`onClose` hooks, and an `AbortSignal`. Ordinary routes do not grow a `subscribe` key (type-level tested).

## 1.4.0

## 1.3.1

## 1.3.0

### Minor Changes

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

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

### Minor Changes

- f1f0e18: Context ergonomics, from beta feedback building on Nifra.

  - **`c.json(body, status?)` / `c.text(body, status?)`** - build a `Response` in one line; the second arg is a status number or a full `ResponseInit`, and it works whether you `return` or `throw` it. Ideal for an auth / rate-limit short-circuit from a `derive`/`beforeHandle`: `throw c.json({ error: "unauthorized" }, 401)` instead of `new Response(JSON.stringify(…), { status: 401, headers: … })`. (In a route's happy path keep returning a plain object so the typed client stays in sync.) Added as prototype methods - no per-request allocation.
  - **One name for the request across routes and loaders.** A route handler's `c.req` is now also `c.request`, and a page loader/action's `ctx.request` is now also `ctx.req` - fixing the `c.req`-vs-`ctx.request` mismatch that was easy to trip over.

  Docs: the API page documents `c.json`/`c.text` + the request alias; a new troubleshooting entry covers a `never` typed client (raw-`Response` return, or a non-identity plugin → `defineIdentityPlugin`).

### Patch Changes

- 3efb7cd: Sharper types + names for two footguns hit building on Nifra.

  - **`defineRouterPlugin`** - a clearer-named alias of `defineIdentityPlugin` for a plugin that mounts routes/hooks but adds **no context type** (an auth router, an audit logger). `definePlugin`'s docs now loudly warn that using it for such a plugin silently collapses the typed client to `any` (no type error, no runtime error). The plugins guide leads with `defineRouterPlugin` and shows the side-effect-then-`return app` mount pattern.
  - **Better error when a route has no `query` schema.** Passing `query` to such a route via the typed client now fails with a message that reads out the fix - `add a \`query\` schema to this route - { query: z.object({ … }) } - so the typed client can accept query params here`- instead of the opaque`not assignable to type 'never'`. The error surfaces at the call site; the fix is at the route. Non-breaking: passing query to a schema-less route was already rejected, just unhelpfully.

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
