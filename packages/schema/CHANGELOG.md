# @nifrajs/schema

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

## 2.2.0

## 2.1.0

## 2.0.0

### Minor Changes

- 1522d06: Path params can now be validated + coerced at the boundary, and query scalars have a coercing constructor - closing the two input slots that lagged behind `body`.

  - **`params` schema slot.** A route (or contract op) can declare `params: t.object({ id: t.string({ format: "uuid" }) })`; a malformed `:id` is now a `422` before the handler runs, exactly like `body`/`query`, instead of an in-handler hand-check. The validated value lands on `c.params` with the schema's output type (a `params` schema can also coerce - use `t.query({ id: t.integer() })` for a numeric path param, and `c.params.id` is a real `number`). Routes without a `params` schema are unchanged: `c.params` stays the path-inferred `Record<name, string>`. The `onValidationError` hook's `kind` gains `"params"`, and params validate first (before body/query). The client's param-call signature is unchanged - a URL segment is still passed as a string.
  - **`t.query(shape)`.** The query-slot analogue of `t.object`, with string->scalar coercion on. Query values always arrive as strings (`?limit=20` -> `"20"`), so a plain `t.object({ limit: t.integer() })` in a `query` slot never validates; `t.query` makes `t.integer()`/`t.number()`/`t.boolean()` fields real numbers/booleans in `c.query`. Open by default (unknown fields such as tracking params are accepted); pass `{ additionalProperties: false }` to enforce a strict allowlist. `t.object` stays the body-slot constructor (a JSON body is already typed - no coercion).

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

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

### Patch Changes

- bd3433f: Security + correctness hardening: `FileStorage` refuses paths that cross symbolic links (component-wise `lstat` walk + `O_NOFOLLOW` writes; `list()` skips symlinks) so a planted symlink can no longer redirect reads/writes outside the storage root. OTel spans no longer copy raw `Error.message` into exported attributes (exception text routinely carries credentials/URLs); spans record `error.recorded: true` instead. New `onResponseFinalized` terminal observer on the server (`Middleware.onResponseFinalized` / `ResponseFinalization`) runs after every transforming `onResponse` hook and is fail-open - tracing now records the true final status even when a later hook rewrites or throws. OpenAPI generation sanitizes URI-style `$id` values into valid component names/`$ref` pointers (hex-derived, collision-suffixed) and is immune to `__proto__` key pollution.

## 1.4.0

### Patch Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

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

### Minor Changes

- 17e57c4: feat(schema): cursor pagination - `t.paginated`, `t.pageQuery`, and cursor helpers

  `t.paginated(item)` is the response envelope schema `{ items: T[]; nextCursor: string | null }`, and
  `t.pageQuery({ maxLimit })` the request query schema `{ cursor?: string; limit?: number }` (an over-limit
  value fails validation). Runtime helpers `encodeCursor` / `decodeCursor` (opaque, URL-safe, edge-safe -
  no `Buffer`) and `paginate(rows, limit, cursorOf)` build a page from a `limit + 1` fetch. Cursor
  pagination - not OFFSET - is the production default: stable under concurrent inserts, O(1) per page.

  `t.pageQuery` coerces its `limit`: query values arrive as strings (`?limit=20` → `"20"`), so without
  coercion the integer `limit` could never validate a real request. Adds an opt-in `fromTypeBox(schema,
{ coerce })` (runs TypeBox `Value.Convert` before `Check`) that `t.pageQuery` uses - body/JSON schemas
  stay strict.

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
