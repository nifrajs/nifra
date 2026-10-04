# @nifrajs/schema

## 4.0.0

### Minor Changes

- dde125b: feat(core): `bodyParser(schema, { types, parse })` from `@nifrajs/core/body-parser` lets one route
  read a request body in a media type other than JSON, urlencoded, or multipart. `parse` is handed the
  body's bytes and what it returns is validated by `schema`, so the handler sees the same typed body
  whatever format it arrived in. JSON and urlencoded bodies still reach the schema through their own
  lanes, and a route that does not opt in still answers `415`.

  ```ts
  import { bodyParser } from "@nifrajs/core/body-parser";
  import { parse } from "yaml";

  const utf8 = new TextDecoder("utf-8", { fatal: true });

  app.post(
    "/pipelines",
    {
      body: bodyParser(Pipeline, {
        types: ["application/yaml"],
        parse: (bytes) => parse(utf8.decode(bytes), { maxAliasCount: 0 }),
      }),
    },
    (c) => c.body.name
  );
  ```

  - The request's media type is matched in full against `types`: case folded, parameters set aside.
    `parse` also receives `{ mediaType, contentType }`.
  - The body is read under the route's `bodyLimit` before `parse` runs: `413 payload_too_large` over
    it, `400 invalid_content_length` for a length that is not one.
  - A `parse` that throws or rejects answers `400 invalid_body`.
  - The decoded value must be a tree. An object, array, `Map` or `Set` reached twice, which is what an
    alias or a cycle decodes to, answers `400 invalid_body` under every `protoPoisoning` setting.
  - `protoPoisoning` applies to the decoded value: a `__proto__` key, a `constructor` that carries a
    `prototype`, and a plain object whose prototype the decoder replaced are rejected or stripped.
    Instances of a class, such as a `Date` or a `Uint8Array`, pass through as they are.
  - `types` takes full `type/subtype` names and throws a `TypeError` for JSON, urlencoded, multipart,
    and `text/plain`. The first three already have readers; `text/plain` is sent by a browser from any
    site without a preflight.
  - A decoder's own limits (nesting depth, alias expansion) are not covered: configure the decoder you
    pass for untrusted input.

  `bodyParser` and `multipartBody` compose in either order, and two `bodyParser` wraps each read their
  own types; the outer one wins a type both name. `multipartBody` now hands a body that is not
  multipart to a reader the schema already carried instead of answering `415` itself.

  feat(schema): `toOpenAPI` and `toOpenAPIFromEvidence` list each media type a `bodyParser` schema
  reads as its own entry under the operation's `requestBody.content`, in a fixed order, next to the
  JSON or multipart entry. `reflectSchema` reports them as `mediaTypes`, and a project evidence
  snapshot carries them, so a document built from a stored snapshot matches the live one.

- 3b090de: feat(core): a route schema takes `cookies`, validated before the handler like `headers` and `query`.

  ```ts
  import { server } from "@nifrajs/core/server";
  import { t } from "@nifrajs/schema";

  export const app = server().get(
    "/dashboard",
    {
      cookies: t.cookies({
        session: t.string(),
        page: t.optional(t.integer()),
      }),
    },
    (c) => ({ session: c.cookies.session, page: c.cookies.page ?? 1 })
  );
  ```

  The schema checks the cookies parsed from the `Cookie` header (URL-decoded values, the first of a
  repeated name) and its output types `c.cookies`. A request that fails it is a `422`, and
  `onValidationError` receives the kind `"cookies"`; code that lists that parameter's kinds by hand
  needs the new member. `defineContract` operations take `cookies` too. Route reflection, contract
  snapshots and diffs, project evidence and the OpenAPI document carry the schema, and OpenAPI lists
  each declared field as an `in: cookie` parameter.

  `t.cookies` builds the schema for this slot. Like `t.query` it coerces declared number and boolean
  fields from text and lets undeclared cookies through, since a browser sends every cookie the site
  has set.

- ff4a062: feat(core): one handler can be registered under several methods, and under a method outside the
  standard seven, with `all()` and `method()` from `@nifrajs/core/methods`:

  ```ts
  import { server } from "@nifrajs/core/server";
  import { all, method } from "@nifrajs/core/methods";

  const app = server()
    // GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS /echo
    .use(all("/echo", (c) => ({ method: c.req.method })))
    .use(method("PURGE", "/cache/:key", (c) => ({ purged: c.params.key })))
    .use(method(["GET", "POST"], "/search", (c) => ({ q: c.query.get("q") })));
  ```

  - Each method is an ordinary route: it is listed by `app.routes()`, takes a schema and hooks, works
    inside `group()`, and throws `DUPLICATE_ROUTE` against a route already registered for the same
    method and path. One call is one registration: if any of its routes is refused, none is added.
  - `all()` is the seven standard methods, not a catch-all. A request with any other method is still a
    `405` with an `Allow` header. `mount()` remains the way to pass every method through.
  - A method name is case-insensitive and registered uppercase. It is a token of letters, digits and
    hyphens that starts with a letter, at most 32 characters. `TRACE`, `CONNECT` and `TRACK` cannot be
    registered; those and any other value throw `INVALID_METHOD`.
  - The standard methods in a call join the typed registry and the typed client. A custom method has
    no typed-client call.
  - An assurance policy's `methods` selector takes standard methods only, so it never matches a
    custom-method route. Classify such a route with a path rule; unmatched, it is reported as
    `unclassified-route`.
  - Whether a custom method reaches the app is up to the runtime's HTTP parser: `PROPFIND`, `REPORT`,
    `PURGE` and `QUERY` arrive on Bun, Node, Deno and workerd, and a token the parser does not know
    can be answered by the runtime itself.
  - `Router.add` from `@nifrajs/core/router` accepts the same method tokens, and
    `isRegistrableMethod(name)` from that subpath reports whether a name is one.
    `RouteDescriptor.method` is typed `RouteMethod`: a standard `Method` or another such token.

  feat(schema): `toOpenAPI` leaves a custom-method route out of the document. A path item has a field
  for each standard method and none for any other.

  feat(cli): `nifra check` reads the routes `all()` and `method()` register, so the duplicate,
  overlap, reserved-segment and param-modifier rules cover them, reported once per call. The route
  brief and `--json` output list a custom-method route with a `fetch` call. The capability report
  attributes a module to every path an optional-param route serves, and to `all()` and `method()`
  routes.

- 7bfa25e: feat(schema): a route body can be a `multipart/form-data` form with file fields. `@nifrajs/schema/form`
  exports a `t` that is the `@nifrajs/schema` builder plus `t.file` and `t.form`; text fields and files
  are validated before the handler runs and typed in `c.body`.

  ```ts
  import { t } from "@nifrajs/schema/form";

  app.post(
    "/avatars",
    {
      body: t.form({
        avatar: t.file({
          maxBytes: 5_000_000,
          accept: ["image/png", "image/jpeg"],
        }),
        caption: t.optional(t.string({ maxLength: 200 })),
      }),
      bodyLimit: 6_000_000,
    },
    (c) => ({ bytes: c.body.avatar.size })
  );
  ```

  `@nifrajs/schema`

  - `t.file({ maxBytes?, accept? })` validates a `File`. The size is checked before a byte is read.
    `accept` takes exact types and `type/*` wildcards and is matched against the file's leading bytes,
    never the type the client claimed; the validated file then carries the detected type. An `accept`
    entry no signature can prove (`text/csv`, `image/svg+xml`, `*/*`) throws when the schema is built.
  - `t.form(fields, options?)` is a route `body` as is. Text fields are coerced from their string form,
    a repeated field is a list, and an undeclared field fails validation unless `additionalProperties`
    is set. `options` also takes the body limits below.
  - `t.array(file)` and `t.optional(file)` work with either `t`. `t.object`, `t.looseObject`, `t.query`,
    `t.union`, `t.record`, and `t.paginated` throw when handed a file field.
  - A zero-byte file part, or an empty text part in a file field, counts as no file. A required list
    field with no entries is `[]`.
  - A form with no required file also accepts `application/json` and
    `application/x-www-form-urlencoded` bodies.
  - `toOpenAPI` emits a body with a file field as `multipart/form-data` unless `requestContentType`
    says otherwise.
  - `@nifrajs/schema` now depends on `@nifrajs/uploads`.

  `@nifrajs/core`

  - `@nifrajs/core/multipart` exports `multipartBody(schema, limits?)`, which marks any Standard Schema
    as a form body, and the `MultipartLimits` and `MultipartValue` types. The route reads the form under
    its `bodyLimit` and hands the schema a record of strings and `File`s; a repeated name is an array.
  - Limits: `maxFields` (default 100), `maxFiles` (10), `maxFieldBytes` (65536), `maxFileBytes`
    (unbounded below `bodyLimit`).
  - Responses: `415 unsupported_media_type` for another content type, `400 invalid_multipart` for a
    body that is not a well-formed form or ends before its closing delimiter, and `413` with
    `payload_too_large`, `too_many_parts`, `too_many_fields`, `too_many_files`, `field_too_large`, or
    `file_too_large`.
  - File names have path separators and control characters removed. Field names follow the server's
    `protoPoisoning` policy.

  `@nifrajs/uploads`

  - `DETECTABLE_MIME_TYPES` and `FILE_TYPE_PREFIX_BYTES` are exported, and `@nifrajs/uploads/detect`
    exports them with `detectFileType` and `FileType` on their own.

  `@nifrajs/client`

  - A body that holds a `File` or `Blob` is sent as `multipart/form-data`. An array value is sent as a
    repeated field, `null` and `undefined` values are left out, and a caller-set `content-type` is
    dropped so the generated boundary is used. A `FormData` body is sent as is. A nested object or list
    cannot be a form field.
  - `inProcessClient` and `testClient` send a `FormData` body with its `content-length`.

  `@nifrajs/edge`

  - A route whose body is a `t.form` or a `multipartBody` schema reads the form, with the same limits
    and responses as the full server.

- 28f3aaf: feat(core): a path can end in optional params, written `:name?`. The route serves the path with the
  param and without it:

  ```ts
  app
    // GET /users and GET /users/42
    .get("/users/:id?", (c) =>
      c.params.id === undefined ? { all: true } : { id: c.params.id }
    )
    // GET /archive, GET /archive/2026 and GET /archive/2026/09
    .get("/archive/:year?/:month?", (c) => ({
      year: c.params.year,
      month: c.params.month,
    }));
  ```

  - Optional params are whole segments at the end of the path. Several in a row are filled left to
    right: a later one is present only when every earlier one is. A `?` anywhere else (`/a/:id?/b`,
    `/v-:id?`) is literal text, as before.
  - An optional param is typed `string | undefined`. When the path omits it, it is absent from
    `c.params`, not an empty string. A `params` schema that requires it answers `422` on the shorter
    path.
  - The route is registered once per path it serves, with the same handler, schema and hooks.
    `app.routes()`, `group()`, `merge()`, `implement()`, `ws()` and the typed registry all see those
    paths, so `GET /users` registered next to `GET /users/:id?` throws `DUPLICATE_ROUTE`. A route that
    is rejected leaves none of its HTTP paths registered.
  - The typed client calls each path: `api.users.get()` and `api.users({ id }).get()`.
  - `defineContract` accepts the same paths; two operations that serve the same method and path are
    refused.
  - `expandOptionalParams(pattern)` from `@nifrajs/core/pattern` returns the paths a pattern serves,
    shortest first. `Router.add` from `@nifrajs/core/router` registers exactly the pattern it is given;
    a caller that wants the optional form adds each expanded pattern.
  - `routePatternOverlap` compares every path each side serves, under one work budget for the call.

  feat(edge): the compact server accepts the same optional params.

  feat(schema): `toOpenAPI` emits one operation per path an optional-param route serves. A shorter
  path declares only the parameters it has. For a contract, the operation name is the `operationId` of
  the full path, and the shorter paths carry none.

  feat(cli): `nifra check` reports `NF-C026` (warning) for a param followed by `?`, `*`, `+`, `{`, `(`
  or `<` that the path grammar reads as literal text, and names a `?` route that no request can reach.
  `// nifra-expect param-modifier` above the registration marks a deliberate literal. Overlap and
  duplicate checks read an optional-param route as every path it serves.

- 6d20355: feat(core): a path param can say which values it accepts, written in braces after the name. A
  request whose value does not fit is not served by that route:

  ```ts
  app
    // /users/me is its own route; /users/42 is this one; /users/ada is a 404
    .get("/users/me", () => ({ me: true }))
    .get("/users/:id{[0-9]+}", (c) => ({ id: Number(c.params.id) }))
    // a list of values, and a count
    .get("/img/:size{thumb|full}/:file", (c) => ({
      size: c.params.size,
      file: c.params.file,
    }))
    .get("/countries/:code{[A-Z]{2}}", (c) => ({ code: c.params.code }))
    // inside a segment, and optional at the end of a path
    .get("/files/:name.:ext{png|jpg}", (c) => ({
      name: c.params.name,
      ext: c.params.ext,
    }))
    .get("/posts/:page{[0-9]+}?", (c) => ({ page: c.params.page ?? "1" }));
  ```

  - A constraint is one character class with an optional count (`[0-9]`, `[a-z0-9_-]+`, `\d{4}`,
    `\w{2,8}`), or a list of two or more values (`png|jpg|webp`). A class holds letters, digits, ranges
    of them, `\d`, `\w` and `. _ ~ ! $ & ' ( ) + , ; = @ -`; there is no negated class and a count
    starts at one. Anything else in braces (`:id{int}`, `:id{.+}`, `:id{[0-9]+|[a-z]+}`) is literal
    text, as before.
  - The param stays a `string`, keyed by its bare name: `Params<"/users/:id{[0-9]+}">` is
    `{ id: string }`.
  - The value is checked as it was sent, before percent-decoding. `/users/4%32` does not fit
    `:id{[0-9]+}`; a broader route beside it serves that request.
  - The narrowest route answers, whatever the order of registration: literal text, then a list, then a
    class, then a bare `:param`, then a wildcard. Between two constraints of a kind, the one that
    accepts fewer values is tried first. A method the narrowest matching route does not have answers
    `405`, as it does for a literal route beside a param route.
  - Two spellings of one constraint (`[0-9]+`, `\d+`, `[0-9]{1,}`) are one route: the same method
    registered on both throws `DUPLICATE_ROUTE`.
  - Inside a segment the text around the params is placed first and each value is then checked; the
    router does not look for another split.
  - `routePatternOverlap` takes constraints into account: `/users/me` and `/users/:id{[0-9]+}` do not
    overlap.
  - `@nifrajs/core/pattern` exports `paramConstraint(text)`, which reads a constraint at the start of
    `text`, and the `ParamConstraint` type. A param part of a compiled mixed segment carries its
    constraint as `c`.

  feat(edge): the compact server accepts the same constraints.

  feat(schema): `toOpenAPI` writes a constrained param into the path template by its bare name
  (`/users/{id}`). Its schema is `{ type: "string", pattern }` for a character class and
  `{ type: "string", enum }` for a list of values; a declared `params` schema still takes precedence.

  feat(client): a constrained param is passed by its bare name, `api.users({ id: "42" }).get()`. Two
  param routes at one position (`/users/:id{[0-9]+}` beside `/users/:slug`, or a param beside a
  wildcard) are each callable, picked by the name of the key. The client does not check a value
  against its constraint.

  feat(cli): `nifra check` accepts a supported constraint and keeps reporting other text in braces
  (`NF-C026`); `NF-C024` and `NF-C025` follow the router's reading of a constraint. `nifra routes` and
  the generated client calls print the bare name. `nifra scaffold` refuses a page path that carries a
  constraint.

  feat(testing): `runAdversarialContract` builds a request path whose values satisfy each param's
  constraint, and fills a part-literal segment (`/files/:name.json`) param by param.

  feat(web): a route file name that would read as a param constraint (`[id]{a|b}.tsx`) is refused at
  build time with a message that names the file. `llms.txt` prints client calls with the bare name.

- 4b8d8de: feat(schema): `t.deferred` and `t.declassified`

  `t.deferred(schema)` describes a loader value marked with `defer()`: `@nifrajs/web` projects and
  validates what it resolves to by `schema` before it streams. `t.declassified(reason, schema)` allows a
  field with a sensitive name (`token`, `password`, `apiKey`, ...) in an output schema and records why
  it may reach the browser. `DeferredValue<T>` is the type of a deferred value.

### Patch Changes

- cfd86b3: A 422 validation response lists at most the first 100 issues, and `t` schemas stop collecting issues at 100, so a large invalid body cannot produce a response many times its own size.
- f56b6a8: The built-in `email` format checks in linear time on any input, and rejects a domain with an empty label (`ada@example..com`, `ada@.example.com`).
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
- Updated dependencies [3bb014f]
- Updated dependencies [3f8fa2b]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0
  - @nifrajs/uploads@4.0.0

## 3.5.0

### Minor Changes

- 82c3018: Add content-free dead-letter projections (`toDeadLetterView`, `toQueueHealth`) for queue triage without exposing payloads or error text; an OpenAPI 3.x inventory importer (`importOpenAPI`, `diffOpenApiInventory`) so export/import roundtrips prove the route table survives in CI; and a seeded hostile prediction/projection lab (`runPredictionLab`, `assertPredictionLab`) covering stale versions, expiry, prototype-grafting and non-atomic patches, commit conflicts, rollback paths, and WebMCP/MCP projection parity. `nifra check` also flags hand-rolled `EventSource`/`WebSocket` to the app's own API under the existing typed-client rule.

## 3.4.0

### Patch Changes

- 719d82e: Centralize release-facing evidence and certification seams so generated views, runtime adapters, and
  consumer checks stay aligned.

## 3.3.0

## 3.2.0

### Patch Changes

- e88c23a: Infer typed status responses across lifecycle hooks and contract-first routes, preserve precise
  success and error narrowing in the client, and optionally include supported response types in
  build-time OpenAPI output. Unsupported TypeScript types remain opaque and explicit runtime schemas
  remain authoritative.

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

- 9a9346e: Routes and contract operations accept a `headers` schema, validated at the boundary alongside
  `body`, `query`, and `params`. Field names are materialized lower-case onto a null-prototype record
  before validation, so a hostile field name (`__proto__`, `constructor`) cannot reach
  `Object.prototype`, and repeated fields arrive already comma-joined by the platform. The validated
  result is available to the handler as typed data instead of ad-hoc `c.req.header(...)` reads, and a
  failure answers the same flat `400` as any other input-validation failure.

  The section flows through the rest of the surface: contract diffs report `headers` as its own
  breaking-change section, and OpenAPI generation emits the schema as `in: header` parameters.

## 2.11.0

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
