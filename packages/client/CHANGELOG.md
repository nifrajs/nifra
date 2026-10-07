# @nifrajs/client

## 4.0.1

## 4.0.0

### Minor Changes

- e8270d9: feat(web): SSR loader, action and boundary calls through `ctx.api` now carry the page request's
  platform identity. A backend reached from a loader sees the visitor's `c.clientIp` (derived under the
  page app's `server.clientIp` trust declaration), `c.env` and `c.waitUntil`, so per-visitor rate limits,
  audit logs and bindings work during SSR. Headers are never copied: a loader call stays anonymous unless
  the loader passes `cookie` or `authorization` itself. `inProcessClient()` / `testClient()` used outside a
  render keep dispatching with no platform.

  New seams in `@nifrajs/core/mount`: `NIFRA_BACKEND_BIND_PLATFORM` (returns a platform-bound view of an
  in-process client) and `NIFRA_PLATFORM_CLIENT_IP_DERIVED` (marks a platform whose `clientIp` an enclosing
  server already derived, so a backend with its own `clientIp` trust keeps it instead of re-reading
  forwarding headers a synthesized request does not carry).

- d942c33: feat(web): a loader or action sets response headers and cookies through `ctx.set`. It has `headers`,
  `cookie()`, and `deleteCookie()`, the page counterpart of a route handler's `c.set`.
  `LoaderResponseControls` is exported from `@nifrajs/web` and `@nifrajs/client`.

  - `ctx.set.headers` applies to the rendered document. It is not applied to a redirect, a status page,
    an error page, or a navigation data response.
  - Each loader has its own header record. They merge layouts root to leaf, then the page loader, then
    the action, so the most specific writer wins a name whichever loader settles first.
  - `content-type`, `set-cookie`, `location`, the transport headers, and the `x-nifra-` prefix are
    refused. So is a name that is not an HTTP token, and a value with a line break, a control
    character, or a character outside Latin-1. The error names the header, never its value.
  - `ctx.set.cookie()` uses the same secure defaults as `c.set.cookie` and rides every outcome,
    including a thrown `Response`. A queued cookie makes the response `cache-control: private, no-store`
    - the document, a redirect, a status or error page, a hand-built `Response` - and keeps the page out
      of `withISR`.
  - The controls close when the loader or action settles. A later write throws.
  - `enableDraft(ctx, secret)` works from a loader or action.

  Behavior changes:

  - A navigation data response, from a loader or an action, is now always
    `cache-control: private, no-store` with `vary: x-nifra-data`. It shares its URL with the document,
    so a cache keyed on the URL must not store it.
  - A document that carries loader headers has `x-nifra-data` added to its `vary`.
  - `withISR` stores a page whose only `vary` token is `x-nifra-data`, and replays `x-robots-tag`.
  - `LoaderContext` and `LoaderArgs` have a required `set`. A test that builds one by hand needs to
    supply it.

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

- d50f73e: feat: generated route types

  Every route file gets a generated `Route` namespace, imported from `./+types/<name>` by both halves
  of the route:

  ```ts
  // routes/blog/[slug].backend.ts
  import type { Route } from "./+types/[slug]"
  export const loaderOutput = t.object({ title: t.string() })
  export async function loader({ api, params }: Route.LoaderArgs) { ... }

  // routes/blog/[slug].tsx
  import type { Route } from "./+types/[slug]"
  export default function Post({ data, params }: Route.ComponentProps) { ... }
  ```

  `Route.Params` comes from the path (`[id]`, optional `[[lang]]`, catch-all `[...path]`).
  `Route.LoaderData` and `Route.ActionData` are the output types of `loaderOutput` and `actionOutput`,
  so a component is typed with exactly what reaches it. `Route.LoaderArgs` types `api` from the app's
  `backend/app.ts`, which `.nifra/types/register.d.ts` registers once with `@nifrajs/client`'s new
  `Register` interface; no route imports the backend for its types.

  `nifra types` writes the files to `.nifra/types` (and `--check` fails when one is stale); `nifra dev`,
  `nifra build` and `nifra check` refresh them, and `nifra dev` keeps them current as routes are added
  or removed. A route resolves `./+types/<name>` through `"rootDirs": [".", "./.nifra/types"]` in
  tsconfig, which the scaffolded site and ISR apps now carry; `nifra types` says so when it is missing.
  `@nifrajs/web/route-types` exports the generator.

- 784d772: `testClient` calls now come from `127.0.0.1`, as a socket peer's would, so middleware keyed on the caller's address, such as `rateLimit()`, runs in tests as it does behind a listener. Pass `clientIp` to test another address. `inProcessClient` calls made outside a page render still carry no address.

  The batteries template declares `@nifrajs/middleware`, and its tests pass on a fresh scaffold.

### Patch Changes

- 57356c0: fix: `ActionData` unwraps `revalidate()` in an action that also returns plain data

  An action returning `revalidate(paths, data)` on one branch and a plain object on another now types
  `actionData` as the union of `data` and the plain returns. Before, the wrapper itself stayed in the
  union, so reading `actionData.ok` failed to type-check.

- 682d8bf: A response body that fails to arrive after its headers - the call's `timeoutMs` running out, the caller's `signal` aborting, or the connection dropping - returns `{ ok: false, status: 0, error: { error: "timeout" } }` or `{ error: "network_error" }`, as a failed fetch does, instead of throwing.
- 4ab5c6a: `.subscribe()` reconnects more carefully. A server's `retry:` hint times the reconnect after a stream it served, but while reconnects keep failing the client still backs off, with the hint as the minimum wait. `retry:` is read as the SSE grammar defines it (ASCII digits only), CR and CRLF line endings are understood alongside LF, an event being assembled is bounded by `maxDecodedBytes`, an `id:` containing NUL is ignored, and an id beyond ASCII is sent back in `Last-Event-ID` as its UTF-8 bytes. Waiting between reconnects no longer leaves a listener behind on the subscription's signal.

  A call with `retry` configured now cancels the body of each response it discards, and stops retrying once the call is aborted or its `timeoutMs` has passed, instead of waiting out the remaining backoff.

- bd6786e: The `.ws()` handle behaves correctly around a closed socket. `messages()` called after the socket closed, or with an already-aborted signal, ends at once instead of waiting forever. `send()` on a closing or closed socket drops the frame, as `WebSocket.send` does, instead of queueing it with nothing left to flush it, and frames queued before a failed connect are released. Ended iterations and closed sockets no longer leave listeners on the signals they were given. `ClientOptions.headers` now documents that a WebSocket handshake never carries them, on any runtime.
- 52bb49e: fix: carry authentication, evidence, and WebSocket boundary guarantees through the typed client and Better Auth integration
- 562b4af: fix(client): a `.` or `..` param value is refused instead of sent

  A URL reads a `.` or `..` path segment as a step to another path, in every encoding, so
  `api.users({ id: ".." }).delete()` was a request for `DELETE /`, not for a user named `..`.

  - A call whose path has a `.` or `..` segment sends nothing and resolves to
    `{ ok: false, status: 0, data: null, error: { error: "invalid_path" } }` - the shape a network
    failure takes. No `onRequest` hook runs and nothing is retried.
  - `.subscribe()` reports `invalid_path` through `onError`, then closes. `.ws()` throws before a
    socket is opened.
  - `inProcessClient` and `testClient` behave the same way.
  - Values that only contain dots (`a.b`, `...`, `.hidden`) and a wildcard value such as `a/../b`
    (sent as one encoded segment) are unaffected.
  - The Python and Go clients from `nifra sdk` refuse the same values: Python raises `ValueError`,
    Go returns an error.

  Validate a param where it is read: a `.` or `..` sent by another client still reaches the route
  as the param's value.

- 81c720e: fix(client): a segment that is part literal, part param is callable through the typed client

  A route such as `/files/:name.json`, `/post-:id` or `/v:major.:minor` could not be reached through
  the typed client: `:name.json` was typed as a param named `name.json` whose call sent the value
  without `.json`, and `post-:id` was typed as a property that sent the pattern text itself. Such a
  segment is now a call with the segment as the request carries it:

  ```ts
  await api.files("report.json").get(); // GET /files/:name.json, c.params.name === "report"
  await api("post-42").get(); // GET /post-:id
  await api("v1.2").get(); // GET /v:major.:minor
  ```

  - The argument is typed as the segment's literal text around any string (`` `${string}.json` ``), so
    `api.files("report.txt")` does not compile. A constraint is not part of the text:
    `/img/:id{[0-9]+}.png` takes `` `${string}.png` ``, and the server decides whether the value fits.
  - The value is sent as one encoded segment, as a param value is: a `/` in it never adds a path level.
  - A static segment at the same position keeps its exact text (`api.files("index.json")` is
    `/files/index.json` when that route exists, which is the route the server picks), and a
    whole-segment param keeps its call by name (`api.files({ id })`).
  - Two such segments at one position that accept the same text resolve to the types of the one
    registered first.
  - `@nifrajs/core` exports `RequestPath<Path>`, the same reading for a whole path:
    `RequestPath<"/files/:name.json">` is `` `/files/${string}.json` ``, a constraint reads as
    `${string}`, and a path ending in optional params is one template per form.
  - The cli's route listings and the generated `llms.txt` print the call the same way
    (`` api.files(`${name}.json`) ``), and print an unnamed wildcard as `({ "*": rest })`.

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

### Patch Changes

- e88c23a: Infer typed status responses across lifecycle hooks and contract-first routes, preserve precise
  success and error narrowing in the client, and optionally include supported response types in
  build-time OpenAPI output. Unsupported TypeScript types remain opaque and explicit runtime schemas
  remain authoritative.

## 3.1.0

## 3.0.0

### Minor Changes

- 5a94db4: The reserved typed-client proxy keys are now a frozen, published contract with a migration path.

  `nifra fix --code NF-C018` rewrites the call sites a reserved-named route segment breaks. It reads the sites from the compiler rather than from a text search, so it finds every one and never mistakes a real `.delete` verb call for a path segment; a site it cannot rewrite confidently (bracket access, a node held in a variable) is reported and left alone rather than guessed at.

  `nifra routes` now annotates a colliding route with the reserved key and the spelling that reaches it, in both the table and `--json`, so the closed set is visible while the route is being written instead of when a build breaks. The typed-client call form printed by `nifra context` and the `nifra_routes` MCP tool is corrected for these routes too: a reserved segment is emitted as a call on the parent node, never as a property or bracket access, both of which the proxy intercepts.

  `@nifrajs/client` exports the set itself - `RESERVED_VERB_KEYS`, `RESERVED_EXACT_KEYS`, `RESERVED_KEY_READOUT`, and `reservedKeyFor(segment)` - as the one place it is written down. The list is frozen: no name is ever added to it, because adding one breaks, at compile time, every consumer that happens to have a route segment with that name. Anything the client gains from here on is reached through a namespaced or symbol key, which no URL path segment can spell.

  Client 2.12.0 should have been a major release: its reserved-segment types reject a property access that compiled in 2.11. Its changelog entry now says so, and `CONTRIBUTING.md` states the rule - a type that stops compiling is a breaking change, runtime behavior notwithstanding, and ships with a codemod.

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

### Patch Changes

- 701961a: New `raw<T>(response)` escape hatch keeps a hand-built `Response` inside the typed contract. A route
  that returns a bare `Response` - a Server-Sent Events stream, a file download, a signed token payload -
  previously inferred `res.data: never` on the client. Wrap the return as `raw<T>(response)` and the
  client sees `res.data` as `Jsonify<T>` while the route still ships the exact `Response` at runtime.
  Branded binary responses from `bytes()` keep their `Blob` typing; only an unbranded `Response` return
  falls back to `never`.

## 2.13.0

## 2.12.1

## 2.12.0

> **Correction (added after release).** This release should have been a `major`. The reserved-segment
> types it introduced reject a property access that compiled in 2.11 - a consumer with a route segment
> named `subscribe`, `then`, `index`, or an HTTP verb sees a compile error after `bun update` inside a
> caret range. "No runtime change" is not the semver test; a type that stops compiling is a breaking
> change. `nifra fix --code NF-C018` now rewrites the broken call sites (it reads them from the
> compiler, so it finds every one), and the reserved set is frozen against ever growing again - see
> `packages/client/src/reserved.ts`.

### Minor Changes

- 27e06a9: Typed collision escape for reserved-named route segments. The client proxy resolves the seven HTTP verbs (any casing) plus `subscribe`, `ws`, `index`, and `then` before path segments, so a route like `POST /api/delete` cannot be reached by dot access - `api.delete` is the DELETE verb. The typed spelling is now a call on the parent node: `api.api("delete").post()` sends `POST /api/delete`. The call signature accepts exactly the colliding segment names under that node (it is not a general string path builder), coexists with param calls on the same node (an object is a param bag, a string literal the segment), and covers all eleven reserved names including `then`. Purely additive - no runtime change, no existing call site affected.

  `NF-C018` accordingly downgrades from error to warning and its message now spells out the escape call for the flagged route, alongside the existing rename and `nifra-expect reserved-segment` options.

### Patch Changes

- 9a692a2: `inProcessClient` now stamps `content-length` on the synthetic requests it builds whenever the body's byte size is knowable (string, `URLSearchParams`, `Blob`, `ArrayBuffer`, typed-array bodies). The `Request` constructor never derives the header, so an in-process POST used to arrive lengthless - which a fail-closed Content-Length gate such as `bodyLimit()` correctly refuses with 411 even though the same call over a socket would carry the header and pass. In-process requests now look exactly like their network twins; stream and `FormData` bodies stay lengthless, matching chunked transfer.

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
