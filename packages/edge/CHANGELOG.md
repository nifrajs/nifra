# @nifrajs/edge

## 4.0.0

### Minor Changes

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

- 4a03d30: feat(core): `notFound(handler)` from `@nifrajs/core/not-found` answers a request no route matched,
  in place of the default `404` body. Apply it with `use()`:

  ```ts
  import { notFound } from "@nifrajs/core/not-found";

  app.use(
    notFound(({ pathname, header }) => {
      if (header("accept")?.includes("text/html")) {
        return new Response("<h1>Nothing here</h1>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return undefined; // the default { ok: false, error: "not_found" }
    })
  );
  ```

  - It answers a `404` only. A path that exists under another method is still a `405` with `Allow`, a
    malformed path parameter is still a `400`, and a `404` a route or a mounted app returned is left
    alone.
  - A `2xx` answer is sent as a `404`, keeping its body and headers. A `3xx`, `4xx` or `5xx` answer is
    sent unchanged. `undefined` keeps the default body. A thrown `Response` is an answer.
  - The handler is given `method`, `url`, `pathname` (as sent, not percent-decoded), `headers`,
    `header(name)`, `signal` and `platform`. It is never given the request body.
  - A throw, a rejection, or a returned value that is not a `Response` is logged once, honouring
    `errorLogDetail`, and answered with the plain `500` `internal_error` body.
  - With `requestTimeoutMs` set, an async handler that outlives it has `signal` aborted and the request
    answered `503`. A deadline header on the request is not consulted for a request no route matched.
  - The answer takes the normal response path: fixed response headers and `onResponse` hooks apply.
  - One handler per server. A second `notFound()` throws, as does one applied inside a `group()` or
    after `listen()`. `merge()` does not carry a merged server's handler across.

  To serve unmatched paths - a single-page app's shell, another app behind this one - register a
  wildcard route or a mount: those are matches, with their own status, the request body, and the full
  route lifecycle.

  feat(edge): `notFound(handler)` from `@nifrajs/edge` builds the same handler for the compact server,
  passed as an option: `server({ notFound: notFound(handler) })`. The rules are the ones above, shared
  with the full server. There is no logger and no request timeout on the compact server, so a fault is
  the plain `500` and the handler bounds its own I/O. An app that does not import `notFound` ships
  none of it.

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

### Patch Changes

- d050528: Route params reach handlers decoded, as on the full server: `/files/a%20b` gives `name: "a b"`, and a malformed escape such as `/files/%E0%A4` answers `400 malformed_path`.
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

- 87272f3: Harden cross-runtime response handling and Node parser-error behavior for production agent hosts.

## 3.1.0

### Minor Changes

- 5b78473: New package `@nifrajs/edge`: a compact fetch-handler server for edge and serverless runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy, Bun). It keeps the `server().get().post()` DX and the full request trust boundary - bounded body read, Content-Length pre-reject, prototype-pollution guard, JSON / urlencoded framing - in a fraction of the bundle, and its rejection envelopes are byte-for-byte the full server's, so an app can graduate to `@nifrajs/core`'s `server()` without its clients noticing.

## 3.0.0

### Minor Changes

- Initial release: a compact fetch-handler server for edge and serverless runtimes. Keeps the `server().get().post()` DX and the full request trust boundary - bounded body read, Content-Length pre-reject, prototype-pollution guard, JSON / urlencoded framing - imported from `@nifrajs/core`, so the rejection envelopes are byte-for-byte the full Server's.
