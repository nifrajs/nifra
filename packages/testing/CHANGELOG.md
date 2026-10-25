# @nifrajs/testing

## 5.7.0

### Patch Changes

- Updated dependencies [25f97c2]
- Updated dependencies [b141cf4]
- Updated dependencies [a97b081]
- Updated dependencies [b3d8ac9]
- Updated dependencies [25f97c2]
- Updated dependencies [d083ad2]
- Updated dependencies [b141cf4]
- Updated dependencies [a57b75c]
- Updated dependencies [911204f]
- Updated dependencies [911204f]
- Updated dependencies [0e59830]
  - @nifrajs/client@5.7.0
  - @nifrajs/core@5.7.0
  - @nifrajs/mock@5.7.0
  - @nifrajs/agent@5.7.0
  - @nifrajs/mcp@5.7.0
  - @nifrajs/webmcp@5.7.0

## 5.6.0

### Patch Changes

- 9efc061: `toOpenAPI` describes routes whose schemas come from a library that implements Standard JSON Schema (`~standard.jsonSchema`, as zod 4 does): a request is described by the schema's input side, a response by its output side. A type the library cannot express, such as zod's `z.date()`, leaves that route without detail, as before. `$defs` in such a schema become components, and a `$ref` to the schema's own root points at a component of its own, so every ref resolves inside the document.
  
  Every operation lists the errors the framework answers before its handler runs. A route with a body lists `400`, `413` and `415` as the shared `NifraError` component (`{ ok: false, error }`), and a route with any request schema lists `422` as `NifraValidationError` (`{ ok: false, error: "validation", issues }`, at most 100 issues). The `422` is left out when a route's `onValidationError` hook or the app's `server({ onValidationError })` writes that body. A response the route or contract declares for the same status wins. A user schema whose `$id` matches one of these names gets a component of its own.
  
  A union whose members all require one property and pin it to distinct values (`t.union` of objects tagged by a `t.literal`, or a zod discriminated union) is emitted as a `oneOf`. When every member is a component it also gets a `discriminator` with a `mapping`; OpenAPI discriminators never consider inline members.
  
  `t.integer()` is bounded to the safe-integer range by default (`minimum: Number.MIN_SAFE_INTEGER`, `maximum: Number.MAX_SAFE_INTEGER`) and its JSON Schema says so. A JSON body or query value past 2^53 - 1 has already been rounded when it is parsed (`9007199254740993` arrives as `9007199254740992`), so it now fails validation with a 422 instead of reaching the handler as a different number. A bound passed to `t.integer()` replaces the default on that side.
  
  `reflectSchema(value, side)` from `@nifrajs/core/reflection` reads a Standard JSON Schema when the value carries no JSON Schema of its own, on the `"input"` (default) or `"output"` side, and marks the result `converted: true`. Route reflection reads response, error and SSE schemas on the output side, and sets `validationErrorHook: true` on a route whose validation failures an `onValidationError` hook answers; project evidence carries that flag. A tool whose input is such a schema now lists its real input schema instead of an empty object.
  
  `@nifrajs/mock` and `@nifrajs/testing` keep deriving a converted schema through their `reflectJsonSchema` hook, as before. `@nifrajs/mock` treats a safe-integer limit as an open side that still caps the range, so a `t.integer()` field still mocks a value between 0 and 100, and one whose own bound sits near a limit stays inside it.
- Updated dependencies [676a1f0]
- Updated dependencies [f1a424d]
- Updated dependencies [0743b66]
- Updated dependencies [671a952]
- Updated dependencies [7c5fc94]
- Updated dependencies [13f6b38]
- Updated dependencies [d76bc3f]
- Updated dependencies [d76bc3f]
- Updated dependencies [4bc7d8d]
- Updated dependencies [aa567fa]
- Updated dependencies [6b90278]
- Updated dependencies [d43bc92]
- Updated dependencies [7810dc5]
- Updated dependencies [6126cb1]
- Updated dependencies [ef2d101]
- Updated dependencies [dec48fc]
- Updated dependencies [f48b257]
- Updated dependencies [0222181]
- Updated dependencies [f39ee8c]
- Updated dependencies [0b9fed9]
- Updated dependencies [4bc7d8d]
- Updated dependencies [4bc7d8d]
- Updated dependencies [a6010f9]
- Updated dependencies [87f475d]
- Updated dependencies [3e1e275]
- Updated dependencies [9efc061]
- Updated dependencies [9889273]
- Updated dependencies [78e64e2]
- Updated dependencies [f25a8d2]
- Updated dependencies [db9f041]
- Updated dependencies [375711b]
- Updated dependencies [bb35ad0]
- Updated dependencies [c7d233d]
- Updated dependencies [feff82f]
- Updated dependencies [a540dad]
  - @nifrajs/core@5.6.0
  - @nifrajs/client@5.6.0
  - @nifrajs/mcp@5.6.0
  - @nifrajs/mock@5.6.0
  - @nifrajs/agent@5.6.0
  - @nifrajs/webmcp@5.6.0

## 5.5.1

### Patch Changes

- Updated dependencies [a0b1ab4]
  - @nifrajs/core@5.5.1
  - @nifrajs/agent@5.5.1
  - @nifrajs/client@5.5.1
  - @nifrajs/mcp@5.5.1
  - @nifrajs/mock@5.5.1
  - @nifrajs/webmcp@5.5.1

## 5.5.0

### Patch Changes

- Updated dependencies [6cc9e11]
- Updated dependencies [abe746a]
- Updated dependencies [28dd544]
- Updated dependencies [662afb0]
- Updated dependencies [662afb0]
- Updated dependencies [61113d8]
- Updated dependencies [389e1b6]
- Updated dependencies [662afb0]
- Updated dependencies [a11fe77]
- Updated dependencies [fa5b67c]
- Updated dependencies [9e6a0a5]
- Updated dependencies [12d93b5]
  - @nifrajs/core@5.5.0
  - @nifrajs/agent@5.5.0
  - @nifrajs/client@5.5.0
  - @nifrajs/webmcp@5.5.0
  - @nifrajs/mcp@5.5.0
  - @nifrajs/mock@5.5.0

## 5.4.0

### Patch Changes

- Updated dependencies [5183c00]
- Updated dependencies [01b97ec]
- Updated dependencies [e589893]
- Updated dependencies [ff66db6]
- Updated dependencies [529f8d2]
  - @nifrajs/core@5.4.0
  - @nifrajs/agent@5.4.0
  - @nifrajs/client@5.4.0
  - @nifrajs/mcp@5.4.0
  - @nifrajs/mock@5.4.0
  - @nifrajs/webmcp@5.4.0

## 5.3.0

### Patch Changes

- Updated dependencies [7ab9692]
- Updated dependencies [61724f9]
- Updated dependencies [808bac8]
- Updated dependencies [d4bae56]
- Updated dependencies [007060d]
- Updated dependencies [46a93c7]
- Updated dependencies [190ab39]
- Updated dependencies [7cf8df3]
  - @nifrajs/agent@5.3.0
  - @nifrajs/client@5.3.0
  - @nifrajs/core@5.3.0
  - @nifrajs/mcp@5.3.0
  - @nifrajs/mock@5.3.0
  - @nifrajs/webmcp@5.3.0

## 5.2.1

### Patch Changes

- @nifrajs/agent@5.2.1
  - @nifrajs/client@5.2.1
  - @nifrajs/core@5.2.1
  - @nifrajs/mcp@5.2.1
  - @nifrajs/mock@5.2.1
  - @nifrajs/webmcp@5.2.1

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.
- 1f3ff32: A closed request-header schema (`headers: t.object({...})`) validates only the header names it declares, each read case-insensitively and keyed as declared. Every client sends headers a route never declares (`host`, `user-agent`, `accept`), so such a schema used to answer every over-the-wire request with a 422; it now matches the OpenAPI document, which lists one `in: header` parameter per declared name. Open schemas, and schemas that do not expose their JSON Schema, still receive every header. `declaredHeaderNames` is exported from `@nifrajs/core/reflection`.
  
  `t.headers({...})` is the open header-slot schema: every header arrives with its name lower-cased, and declared `t.integer()` / `t.number()` / `t.boolean()` fields are coerced from text. It refuses an upper-case name.
  
  `runAdversarialContract` sends the headers real clients send (`accept`, `accept-encoding`, `accept-language`, `user-agent`), validates a header witness the way the route's slot does, and names the refused fields when a witness is rejected or a valid witness is answered with a validation 422.
- Updated dependencies [9498cf8]
- Updated dependencies [1f3ff32]
- Updated dependencies [4bb8e52]
- Updated dependencies [cdff19d]
- Updated dependencies [5edd0ba]
- Updated dependencies [000b4cb]
- Updated dependencies [c5455fb]
- Updated dependencies [6082ba5]
- Updated dependencies [fd58beb]
- Updated dependencies [ea25a61]
- Updated dependencies [ed13e36]
  - @nifrajs/agent@5.2.0
  - @nifrajs/client@5.2.0
  - @nifrajs/core@5.2.0
  - @nifrajs/mcp@5.2.0
  - @nifrajs/mock@5.2.0
  - @nifrajs/webmcp@5.2.0

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.
- Updated dependencies [abb4354]
- Updated dependencies [b276c67]
- Updated dependencies [2a0a5d3]
- Updated dependencies [72e1b4b]
  - @nifrajs/agent@5.1.0
  - @nifrajs/mcp@5.1.0
  - @nifrajs/mock@5.1.0
  - @nifrajs/webmcp@5.1.0
  - @nifrajs/core@5.1.0
  - @nifrajs/client@5.1.0

## 5.0.0

### Major Changes

- 4199ff3: The adversarial contract laboratory witnesses and mutates declared `params` and `headers`. A `t` schema synthesizes them, the witness's `params` and `headers` override, and each is validated before any case runs, so a body or query case is rejected by the input it mutates rather than by a placeholder param or a missing header. An opaque params or headers schema without a witness is a `NO_WITNESS` gap; placeholders no longer stand in for it.

  The laboratory never invents credentials: `authorization`, `proxy-authorization`, `cookie`, `x-api-key`, and names ending in `-key` or containing `token`, `secret` or `signature` come from the witness and `prepareRequest` only and are never mutated, and runtime-owned headers are never set. A schema that requires a credential the witness lacks is a `NO_WITNESS` gap naming it. Cookies are never synthesized: a route with a `cookies` schema needs `headers.cookie` in its witness, else a `cookies` gap. A params or header field typed as bare text is not a `NO_REJECTED_MUTATION` gap. `ContractTarget` adds `"headers"`, `"cookies"` and `"params"`.

  `autoReflectJsonSchema` resolves zod from the project directory first, then from `@nifrajs/mock`. `explainAutoReflectJsonSchema` says why a zod schema stayed opaque (zod not resolvable, older than 4, or its converter threw), and a laboratory gap for such a schema carries the reason.

- b7eff12: `compareAgentEvalBaseline` and `assertAgentEvalBaseline` now fail by default on a verdict the current run stopped producing (`missing`) or whose rubric changed shape (`incomparable`), not only on `regressed`. A verdict new in the current run gets its own `added` code and does not fail. Pass `failOn: ["regressed"]` for the old behaviour. `runAgentFailureMatrix` takes an `execute(boundary, checkpoint)` option that drives the agent under test through each boundary; a case passes only when the injected crash surfaces. Without it the matrix still proves only its own schedule.

### Minor Changes

- dd0e530: `CacheStore` gains two optional methods for a store that several caches or processes share: `fence(key, tags)` and `setIfFence(key, entry, tags, token)`. A `wrap` load takes a fence before its loader runs and stores its result through `setIfFence`, which refuses the write when a `set` or `delete` of the key, an `invalidateTag` of one of its tags, or a `clear` ran in the meantime from any cache sharing the store. `MemoryCache` implements both, so two caches over one `MemoryCache` no longer write back a value the other invalidated.

  A `delete`, `invalidateTag` or `clear` now runs after the cache's own async store writes it covers, so a store that applies requests out of order cannot land an earlier write after the invalidation.

  `cacheStoreCertificationProfile({ fencing: true })` adds the `fenced-write` capability, which checks a store's `fence` and `setIfFence`.

- c333ca7: The cache, job and storage certification profiles now fail the adapters they should, and pass the ones they should. Each profile moves to version 2.

  - **cache-store**: entries are fresh until 2100. A store that honors expiry on the wall clock used to fail, because the old entries expired in 1970.
  - **job-store**: a new `lease-exclusive` check, under `lease-complete`. A leased job must stay hidden from other workers until its lease runs out, and then come back. A store that handed one job to every worker used to pass.
  - **storage-adapter**: a new required `key-safety` capability. `put`, `get`, `exists` and `delete` must refuse a `..` segment, an absolute key, a backslash, a NUL, and an empty, `.` or trailing segment, as `@nifrajs/storage`'s key contract does.

- 7544cc0: `generateRegressionTest` redacts query values, header values other than `content-type`, and the capsule note by default, not only body strings, and raises the sanitize banner when it does. New `allowQuery`, `allowHeaders` and `keepNote` options keep chosen values verbatim. The emitted file also asks for the path, which is kept verbatim, to be reviewed.
- 9f58295: An opaque mount can declare the routes it serves: `opaque: { reason, routes: [{ method, path, capabilities }] }` on `mount()`, `mountFetch()` and a `createWebApp` `mounts` entry. Capability assurance reports those routes with `analysis: "declared"` beside the known gap, checks their capabilities against the policy (an unknown id, or a domain write on a safe method, fails), and records them in the lockfile. `reflectMounts` returns them, project evidence carries them, the `nifra context` index lists them, and an adversarial contract run notes them as having no contract to test. A malformed declaration or a path outside the mount stops the analysis with an error that names it. A mount without a reason fails as before.
- b40e83e: `captureIncident` keeps every query pair in order as `request.queryPairs` when the `query` object cannot rebuild it, such as a repeated name, and keeps a non-JSON request body as its text with `request.bodyEncoding: "text"`. `replayIncident` sends both back exactly as captured, so a request with `?q=a&q=b` or a `text/plain` body reproduces. `generateRegressionTest` redacts the values in `queryPairs` like those in `query`.

### Patch Changes

- 8860117: `runDataAdapterConformance` no longer certifies an adapter that breaks three of its guarantees:

  - **cancellation** passed on any error, because the signal it checked had always been aborted. It now needs an abort error, and the cancelled row must not be stored.
  - **pagination** passed when every page was empty. The pages must now return exactly the rows a read of the scope returns.
  - **backup-restore** passed when restore deleted everything. Both scopes must now hold exactly the rows they held at the snapshot.

- dab880c: `generateRegressionTest()` writes the captured method, path and status into the generated test only as escaped string literals. A path containing `"` used to close the `describe()` title and inject statements that ran when the test file was imported. The import path is emitted the same way, and `appExport` must be a plain identifier.
- 846e2f6: `invariants` in `nifra.assurance.ts` accepts the L4 runner's fixture options - `witnesses`, `prepareRequest`, `isRejected`, `include` and `maxMutationsPerInput` - and `nifra levels` and the `nifra_levels` MCP tool pass them to every L4 run. `invariants.setup` provisions a throwaway target only when L4 runs: it is called once, before the first L4 request and never when the config is imported, and the `teardown` it returns runs after the run, a failing one included. A config needs an `executor`, a `setup`, or both. The contract witness and case-context types now live in `@nifrajs/core/assurance`; `@nifrajs/testing` re-exports them unchanged.
- c92f85f: The default `reflectJsonSchema` hook reads a schema's own Standard JSON Schema converter (`~standard.jsonSchema.input`, implemented by zod 4.2+ and other libraries) before it looks for zod on disk. The adversarial laboratory and the mock server now inspect such a schema wherever the test runs from, including a monorepo root whose zod is installed only in one app, and a validator other than zod that implements the converter gets witnesses and mock data too. An older zod 4 is still converted with `z.toJSONSchema`. When a converter throws, the gap names it.
- c669c6a: `cookieJar` removes a cookie for any `Max-Age` of zero or less (`Max-Age=-1`, `Max-Age=00`), and lets `Max-Age` outrank `Expires`, as browsers do. Only an exact `Max-Age=0` counted before, so a test could pass with a cookie a browser would already have dropped.
- 067ea67: `generateRegressionTest` now adds a review banner when the emitted request body keeps numbers, booleans or object keys verbatim. Only string values are redacted, so a card number or an email used as a key went into the fixture with no prompt to check it.
- 6e88552: `replayTrajectory` now fires tool faults. Replay runs tools dry, so a tool's own `execute` never runs, and the faults were injected there. A `tool-error`, `cancellation` or `budget-pressure` fault on the `tool` point never fired, and the replay reported a completed run. Tool faults now fire at the budget check that a dry tool call still makes: a tool error fails the call with `execution_failed`, a cancellation cancels the call and the run, and budget pressure fails the call with `budget_exceeded`. Replay still runs no real tool.
- Updated dependencies [2198640]
- Updated dependencies [6b96131]
- Updated dependencies [d6a7fa0]
- Updated dependencies [6340cd8]
- Updated dependencies [34b3014]
- Updated dependencies [848ce97]
- Updated dependencies [a0a02f4]
- Updated dependencies [0aed425]
- Updated dependencies [eaf030b]
- Updated dependencies [7de0397]
- Updated dependencies [1af7543]
- Updated dependencies [4edee67]
- Updated dependencies [281f5de]
- Updated dependencies [6a95376]
- Updated dependencies [6426107]
- Updated dependencies [23b3672]
- Updated dependencies [4199ff3]
- Updated dependencies [90d9ee6]
- Updated dependencies [364a234]
- Updated dependencies [c06cba5]
- Updated dependencies [f4d3852]
- Updated dependencies [4a82ae0]
- Updated dependencies [0ff867a]
- Updated dependencies [e7391bf]
- Updated dependencies [0b80a59]
- Updated dependencies [c64db12]
- Updated dependencies [3753104]
- Updated dependencies [4b3b1fa]
- Updated dependencies [3562557]
- Updated dependencies [53087f3]
- Updated dependencies [2def6c7]
- Updated dependencies [b5b5bc3]
- Updated dependencies [22e1777]
- Updated dependencies [3a483cd]
- Updated dependencies [35f52c7]
- Updated dependencies [343cb81]
- Updated dependencies [d91fd44]
- Updated dependencies [b13e071]
- Updated dependencies [077657f]
- Updated dependencies [a5963cb]
- Updated dependencies [05aac0e]
- Updated dependencies [1a6616f]
- Updated dependencies [7775c2b]
- Updated dependencies [846e2f6]
- Updated dependencies [aadd9fc]
- Updated dependencies [1bd2352]
- Updated dependencies [f0c88c1]
- Updated dependencies [ea16748]
- Updated dependencies [fc0284a]
- Updated dependencies [5b22f4d]
- Updated dependencies [1b94593]
- Updated dependencies [9f58295]
- Updated dependencies [b9608ac]
- Updated dependencies [7a165de]
- Updated dependencies [4064f36]
- Updated dependencies [b70b18a]
- Updated dependencies [48aad8c]
- Updated dependencies [41050ed]
- Updated dependencies [fc837cb]
- Updated dependencies [c92f85f]
- Updated dependencies [b80ce77]
- Updated dependencies [9b1acc9]
- Updated dependencies [740109f]
- Updated dependencies [bdd6231]
- Updated dependencies [e0a25fe]
- Updated dependencies [3630b6e]
- Updated dependencies [1290c6d]
- Updated dependencies [d0a7d58]
  - @nifrajs/agent@5.0.0
  - @nifrajs/core@5.0.0
  - @nifrajs/mcp@5.0.0
  - @nifrajs/client@5.0.0
  - @nifrajs/mock@5.0.0
  - @nifrajs/webmcp@5.0.0

## 4.0.2

### Patch Changes

- @nifrajs/agent@4.0.2
- @nifrajs/client@4.0.2
- @nifrajs/core@4.0.2
- @nifrajs/mcp@4.0.2
- @nifrajs/mock@4.0.2
- @nifrajs/webmcp@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/agent@4.0.1
- @nifrajs/client@4.0.1
- @nifrajs/core@4.0.1
- @nifrajs/mcp@4.0.1
- @nifrajs/mock@4.0.1
- @nifrajs/webmcp@4.0.1

## 4.0.0

### Minor Changes

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

- af7648c: feat(testing): browser-test glue (`serveTestApp`, `e2eUrl`)

  `@nifrajs/testing/e2e` covers what in-process testing cannot: a real socket, real
  navigation, real rendering. `serveTestApp(app)` binds the app to an ephemeral port
  (via the optional `@nifrajs/node` peer) and stops cleanly; `e2eUrl<typeof app>(base,
path)` typechecks the visited path against the route registry, so a typo'd URL fails
  typecheck instead of 404ing mid-suite. Login stays in-process through `testSession` -
  the session jar crosses into the browser as a `Cookie` header. Bring your own
  Playwright/Vitest runner; this is the glue, documented with recipes on `/docs/testing`.

- 1afbe9f: `jobStoreCertificationProfile({ traceparent: true })` adds the optional `traceparent-roundtrip` capability: a store hands the `traceparent` given to `enqueue` back on every lease, including after a retry, and leaves it absent when none was given.

### Patch Changes

- ef28ef9: An agent eval case orders its rubric verdicts by code unit, so the case digest is the same on every machine and in every locale. A case whose rubric ids sort differently around `.`, `_`, `:` or `-` can digest differently from an earlier release.
- fab1d24: `e2eUrl` and `e2eWebSocket` refuse a path that does not stay on the test app's origin with one error, "must be a same-origin absolute path", whichever check catches it.
- Updated dependencies [6695a23]
- Updated dependencies [7b2ff47]
- Updated dependencies [422248c]
- Updated dependencies [62115dd]
- Updated dependencies [dbc91b6]
- Updated dependencies [d2329f5]
- Updated dependencies [1eb77df]
- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [57356c0]
- Updated dependencies [682d8bf]
- Updated dependencies [4ab5c6a]
- Updated dependencies [bd6786e]
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
- Updated dependencies [d942c33]
- Updated dependencies [d4d40a5]
- Updated dependencies [9ccf198]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [84e0744]
- Updated dependencies [7bfa25e]
- Updated dependencies [52bb49e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [d50f73e]
- Updated dependencies [b64c3ee]
- Updated dependencies [784d772]
- Updated dependencies [bda9637]
- Updated dependencies [562b4af]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [6323d38]
- Updated dependencies [ff25d68]
  - @nifrajs/agent@4.0.0
  - @nifrajs/core@4.0.0
  - @nifrajs/client@4.0.0
  - @nifrajs/mcp@4.0.0
  - @nifrajs/mock@4.0.0
  - @nifrajs/webmcp@4.0.0

## 3.5.0

### Minor Changes

- 82c3018: Add content-free dead-letter projections (`toDeadLetterView`, `toQueueHealth`) for queue triage without exposing payloads or error text; an OpenAPI 3.x inventory importer (`importOpenAPI`, `diffOpenApiInventory`) so export/import roundtrips prove the route table survives in CI; and a seeded hostile prediction/projection lab (`runPredictionLab`, `assertPredictionLab`) covering stale versions, expiry, prototype-grafting and non-atomic patches, commit conflicts, rollback paths, and WebMCP/MCP projection parity. `nifra check` also flags hand-rolled `EventSource`/`WebSocket` to the app's own API under the existing typed-client rule.

### Patch Changes

- Updated dependencies [6046984]
- Updated dependencies [d5b7c22]
  - @nifrajs/core@3.5.0
  - @nifrajs/agent@3.5.0
  - @nifrajs/client@3.5.0
  - @nifrajs/mcp@3.5.0
  - @nifrajs/mock@3.5.0
  - @nifrajs/webmcp@3.5.0

## 3.4.0

### Patch Changes

- 719d82e: Centralize release-facing evidence and certification seams so generated views, runtime adapters, and
  consumer checks stay aligned.
- Updated dependencies [8d23613]
- Updated dependencies
- Updated dependencies
- Updated dependencies [719d82e]
  - @nifrajs/agent@3.4.0
  - @nifrajs/mcp@3.4.0
  - @nifrajs/core@3.4.0
  - @nifrajs/client@3.4.0
  - @nifrajs/mock@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/agent@3.3.0
- @nifrajs/client@3.3.0
- @nifrajs/core@3.3.0
- @nifrajs/mcp@3.3.0
- @nifrajs/mock@3.3.0

## 3.2.0

### Patch Changes

- 1a041a9: Add provider-neutral gateway and deployment contracts with deterministic reference adapters and evidence-safe policy checks.
- 6aa39aa: Add a runtime-neutral HTTP contract lab with shared request/response witnesses for Bun, Node, Deno, and edge adapter verification.
- c39712e: Move route policy compilation and deploy-target planning behind shared internal seams, pin the Solid adapter's Babel type identity, and add a cleanup-safe cross-runtime contract-lab runner.
- Updated dependencies [7aee593]
- Updated dependencies [8486ed8]
- Updated dependencies [1a041a9]
- Updated dependencies [3eacb4a]
- Updated dependencies [8b58d1f]
- Updated dependencies [893f7b3]
- Updated dependencies [cefedc2]
- Updated dependencies [095c320]
- Updated dependencies [7504864]
- Updated dependencies [e88c23a]
- Updated dependencies [c39712e]
- Updated dependencies [9010fd3]
- Updated dependencies [7551709]
- Updated dependencies [ea2356e]
- Updated dependencies [a816b87]
  - @nifrajs/agent@3.2.0
  - @nifrajs/mcp@3.2.0
  - @nifrajs/core@3.2.0
  - @nifrajs/client@3.2.0
  - @nifrajs/mock@3.2.0

## 3.1.0

### Patch Changes

- Updated dependencies [5b78473]
- Updated dependencies [1400f6c]
- Updated dependencies [a7db515]
  - @nifrajs/core@3.1.0
  - @nifrajs/agent@3.1.0
  - @nifrajs/client@3.1.0
  - @nifrajs/mcp@3.1.0
  - @nifrajs/mock@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [f0fd370]
- Updated dependencies [5a94db4]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0
  - @nifrajs/client@3.0.0
  - @nifrajs/agent@3.0.0
  - @nifrajs/mcp@3.0.0
  - @nifrajs/mock@3.0.0

## 2.14.1

### Patch Changes

- Updated dependencies [bf93902]
  - @nifrajs/core@2.14.1
  - @nifrajs/agent@2.14.1
  - @nifrajs/client@2.14.1
  - @nifrajs/mcp@2.14.1
  - @nifrajs/mock@2.14.1

## 2.14.0

### Patch Changes

- Updated dependencies [701961a]
- Updated dependencies [62133bf]
- Updated dependencies [8dffdf4]
  - @nifrajs/core@2.14.0
  - @nifrajs/client@2.14.0
  - @nifrajs/agent@2.14.0
  - @nifrajs/mcp@2.14.0
  - @nifrajs/mock@2.14.0

## 2.13.0

### Patch Changes

- Updated dependencies [e0b2dd6]
- Updated dependencies [7535ce1]
- Updated dependencies [1704308]
  - @nifrajs/core@2.13.0
  - @nifrajs/agent@2.13.0
  - @nifrajs/client@2.13.0
  - @nifrajs/mcp@2.13.0
  - @nifrajs/mock@2.13.0

## 2.12.1

### Patch Changes

- Updated dependencies [fba30c7]
  - @nifrajs/core@2.12.1
  - @nifrajs/agent@2.12.1
  - @nifrajs/client@2.12.1
  - @nifrajs/mcp@2.12.1
  - @nifrajs/mock@2.12.1

## 2.12.0

### Minor Changes

- 3868e1b: Add a deterministic fault-profile seam and a reference profile for adapter simulation.
- a5d3f5b: Add stable diagnostic codes, application-supplied rule packs, fix recipes, assurance bundles, contract lock snapshots, hydration assurance hooks, replay metadata, security verification rules, and idempotency proofs.
- e2d1939: Add typed tool contracts with shared fail-closed adapters, static verification work graphs, bounded provider-neutral agent turns, deterministic trajectory replay, and an explicit execution-policy seam with a non-isolating local process adapter.

### Patch Changes

- Updated dependencies [c2f99b1]
- Updated dependencies [df100d3]
- Updated dependencies [0efacea]
- Updated dependencies [cd1732c]
- Updated dependencies [df100d3]
- Updated dependencies [27e06a9]
- Updated dependencies [9a9346e]
- Updated dependencies [b5f47c0]
- Updated dependencies [fc33c0f]
- Updated dependencies [c4e8bb0]
- Updated dependencies [11d1658]
- Updated dependencies [9a692a2]
- Updated dependencies [5f71c23]
- Updated dependencies [3788b36]
- Updated dependencies [ae5338f]
- Updated dependencies [8847825]
- Updated dependencies [cb04de8]
- Updated dependencies [f3cc02e]
- Updated dependencies [9a9346e]
- Updated dependencies [5e4e31a]
- Updated dependencies [9a9346e]
- Updated dependencies [b045f9e]
- Updated dependencies [9a9346e]
- Updated dependencies [9a9346e]
- Updated dependencies [dbc0b79]
- Updated dependencies [bd5c624]
- Updated dependencies [a5d3f5b]
- Updated dependencies [00819c5]
- Updated dependencies [e2bdd4a]
- Updated dependencies [e2d1939]
- Updated dependencies [e83e6eb]
- Updated dependencies [f8b0097]
  - @nifrajs/agent@2.12.0
  - @nifrajs/core@2.12.0
  - @nifrajs/client@2.12.0
  - @nifrajs/mcp@2.12.0
  - @nifrajs/mock@2.12.0

## 2.11.0

### Patch Changes

- @nifrajs/client@2.11.0
- @nifrajs/core@2.11.0
- @nifrajs/mock@2.11.0

## 2.10.0

### Patch Changes

- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
  - @nifrajs/core@2.10.0
  - @nifrajs/client@2.10.0
  - @nifrajs/mock@2.10.0

## 2.9.1

### Patch Changes

- Updated dependencies [01e36fb]
  - @nifrajs/core@2.9.1
  - @nifrajs/client@2.9.1
  - @nifrajs/mock@2.9.1

## 2.9.0

### Patch Changes

- Updated dependencies [b006d07]
- Updated dependencies [e05e56d]
  - @nifrajs/client@2.9.0
  - @nifrajs/core@2.9.0
  - @nifrajs/mock@2.9.0

## 2.8.2

### Patch Changes

- Updated dependencies [f7d68e8]
  - @nifrajs/core@2.8.2
  - @nifrajs/client@2.8.2
  - @nifrajs/mock@2.8.2

## 2.8.1

### Patch Changes

- Updated dependencies [78d66a4]
- Updated dependencies [93fdc89]
  - @nifrajs/core@2.8.1
  - @nifrajs/client@2.8.1
  - @nifrajs/mock@2.8.1

## 2.8.0

### Patch Changes

- @nifrajs/client@2.8.0
- @nifrajs/core@2.8.0
- @nifrajs/mock@2.8.0

## 2.7.1

### Patch Changes

- Updated dependencies [52c89e0]
  - @nifrajs/core@2.7.1
  - @nifrajs/client@2.7.1
  - @nifrajs/mock@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/client@2.7.0
- @nifrajs/core@2.7.0
- @nifrajs/mock@2.7.0

## 2.6.1

### Patch Changes

- Updated dependencies [5840c98]
  - @nifrajs/core@2.6.1
  - @nifrajs/client@2.6.1
  - @nifrajs/mock@2.6.1

## 2.6.0

### Patch Changes

- Updated dependencies [e6349e5]
  - @nifrajs/core@2.6.0
  - @nifrajs/client@2.6.0
  - @nifrajs/mock@2.6.0

## 2.5.0

### Minor Changes

- 31ccc27: The adversarial laboratory and the mock server now recognize zod automatically - no wiring. Every Standard Schema carries a `"~standard".vendor` tag, so when a body/query/response validator says "zod" and zod (4+) is installed, the new `autoReflectJsonSchema` default (exported from `@nifrajs/mock`) converts it via `z.toJSONSchema` exactly as the `@nifrajs/testing/zod` bridge does. Out of the box, zod routes now get synthesized witnesses and constraint-driven mutations in `runAdversarialContract`/`assertAdversarialContract` instead of NO_WITNESS, and `createMockServer` returns real data instead of `{}`. zod stays an optional peer, loaded lazily and probed once; a project without zod (or with a schema zod cannot convert) keeps today's opaque behavior. An explicit `reflectJsonSchema` hook always overrides the default - pass `() => undefined` to force everything opaque.

### Patch Changes

- Updated dependencies [31ccc27]
- Updated dependencies [da7f2d5]
  - @nifrajs/mock@2.5.0
  - @nifrajs/client@2.5.0
  - @nifrajs/core@2.5.0

## 2.4.0

### Minor Changes

- 06f4aaa: Contract tooling works out of the box for validators that expose no JSON Schema (zod, valibot, arktype).

  `runAdversarialContract` / `assertAdversarialContract` and `createMockServer` accept a `reflectJsonSchema` hook that derives an inspectable JSON Schema from an opaque Standard Schema validator. With it, zod routes get synthesized witnesses and constraint-driven mutations (min/max, length, pattern, enum, format) instead of a `NO_WITNESS` gap, and mocked responses carry real data instead of `{}`. A ready-made zod bridge ships as `@nifrajs/testing/zod` (`zodJsonSchema`); `zod` is an optional peer, so only projects that import that subpath need it installed. The adversarial report also gains an `advisories` list that flags when `validateResponses` is on but no route declares a `response` schema, making silently-zero response coverage visible.

### Patch Changes

- Updated dependencies [138bfba]
- Updated dependencies [06f4aaa]
  - @nifrajs/core@2.4.0
  - @nifrajs/mock@2.4.0
  - @nifrajs/client@2.4.0

## 2.3.0

### Patch Changes

- Updated dependencies [6f5b3ad]
- Updated dependencies [85b354d]
- Updated dependencies [9b110b9]
- Updated dependencies [8514caa]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [b271164]
- Updated dependencies [8c77d47]
- Updated dependencies [ea0a27f]
- Updated dependencies [5fe332a]
- Updated dependencies [c823915]
- Updated dependencies [d2840ac]
  - @nifrajs/core@2.3.0
  - @nifrajs/client@2.3.0
  - @nifrajs/mock@2.3.0

## 2.2.0

### Patch Changes

- Updated dependencies [5f460db]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [6aa0aac]
  - @nifrajs/core@2.2.0
  - @nifrajs/client@2.2.0
  - @nifrajs/mock@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
- Updated dependencies [d3aac63]
  - @nifrajs/core@2.1.0
  - @nifrajs/client@2.1.0
  - @nifrajs/mock@2.1.0

## 2.0.0

### Patch Changes

- b7017b9: Map `@nifrajs/testing/certification` in the workspace TypeScript paths, so the subpath resolves from
  source like every other first-party entry instead of only through built declarations.
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [d91a45b]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0
  - @nifrajs/client@2.0.0
  - @nifrajs/mock@2.0.0

## 1.13.0

### Patch Changes

- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0
  - @nifrajs/client@1.13.0
  - @nifrajs/mock@1.13.0

## 1.12.0

### Minor Changes

- 63d3845: Add bounded execution-causality contracts and propagation, OpenTelemetry causal links, event-envelope lineage, and a deterministic durable failure laboratory. `nifra levels` L4 now uses the deep adversarial contract engine through its explicitly isolated executor. Also add hash-verifiable adapter certification profiles and duplicate physical Nifra/React install detection in `nifra doctor`/`nifra check`.

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0
  - @nifrajs/client@1.12.0
  - @nifrajs/mock@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0
  - @nifrajs/client@1.11.0
  - @nifrajs/mock@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0
  - @nifrajs/client@1.10.0
  - @nifrajs/mock@1.10.0

## 1.9.1

### Patch Changes

- @nifrajs/client@1.9.1
- @nifrajs/core@1.9.1
- @nifrajs/mock@1.9.1

## 1.9.0

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0
  - @nifrajs/client@1.9.0
  - @nifrajs/mock@1.9.0

## 1.8.0

### Minor Changes

- 6b375fc: Add a deterministic contract laboratory that synthesizes valid request witnesses, proves hostile
  mutations invalid with each route's own Standard Schema validator, checks boundary rejection across a
  runtime matrix, validates declared success responses, shrinks failures, and retains replay seeds.
- eeb6075: Add incident → regression: turn a failed request into a committed test - the one thing a generic error
  tracker (Sentry/PostHog) can't do, because it needs the framework's contract + in-process replay.
  `captureIncident(request, response)` records a request + observed response; `replayIncident` /
  `assertIncidentReplays` re-run it against the CURRENT app and assert the response contract (status, and
  optionally shape) still reproduces; `generateRegressionTest` emits a committable `.test.ts`. In-memory
  replay uses the real captured inputs (exact, no leak); the emitted fixture redacts request string values
  BY DEFAULT behind a sanitize banner, so a committed test never carries PII/secrets. This complements
  error tracking - it does not store incidents or replace observability.

### Patch Changes

- Updated dependencies [e47c4c5]
  - @nifrajs/core@1.8.0
  - @nifrajs/client@1.8.0
  - @nifrajs/mock@1.8.0

## 1.7.0

### Patch Changes

- @nifrajs/client@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/client@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [70aa836]
  - @nifrajs/client@1.5.0

## 1.4.0

### Patch Changes

- @nifrajs/client@1.4.0

## 1.3.1

### Patch Changes

- @nifrajs/client@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [4a4b1c4]
  - @nifrajs/client@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/client@1.2.2

## 1.2.1

### Patch Changes

- @nifrajs/client@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/client@1.2.0

## 1.1.0

### Minor Changes

- acb9e97: feat(testing): add `@nifrajs/testing` - cookie-aware in-process test sessions

  `@nifrajs/client`'s `testClient` already drives an app's `fetch` with end-to-end types (no server, port,
  or network). This adds what it doesn't: a `cookieJar()` and a cookie-persisting `testSession(app)`, so a
  login → authenticated-request flow tests as easily as a single request - `Set-Cookie` is captured and the
  `Cookie` header is sent automatically across calls (honouring `Max-Age=0` / past `Expires` for logout).
  Same typed in-process client; the only addition is a shared cookie jar.

### Patch Changes

- @nifrajs/client@1.1.0
