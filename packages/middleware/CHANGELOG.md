# @nifrajs/middleware

## 5.4.0

### Patch Changes

- @nifrajs/schema@5.4.0

## 5.3.0

### Patch Changes

- 400d1fa: `prettyJson()` passes a response through unchanged when its indented form would outgrow it more than eightfold (with a 64 KiB floor). Indentation repeats the nesting depth on every line, so a few kilobytes of deeply nested JSON, for example a request body an endpoint echoes back, expanded to tens of megabytes. The budget is checked before each line is built, so nothing past it is allocated.
- 808bac8: A response body refused by its `content-length` alone is now cancelled. `readBoundedBytes` (behind the typed client's `maxDecodedBytes` and `decodeTransportResponse`) and the `jwks()` key fetch threw on an oversized declared length without touching the body, which left the stream, and its connection, open until the sender gave up.
- 69dfb60: `rangeResponse()` and `servePublicDir` ignore a `Range` header on a HEAD request, as RFC 9110 section 14.2 defines range handling for GET only: HEAD answers 200 with the full `content-length` and no `content-range`, the same as the Node static bridge. Before, HEAD with `Range` answered 206 or 416 with the metadata of the requested slice.
- Updated dependencies [7ab9692]
  - @nifrajs/schema@5.3.0

## 5.2.1

### Patch Changes

- @nifrajs/schema@5.2.1

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.
- Updated dependencies [9498cf8]
- Updated dependencies [1f3ff32]
  - @nifrajs/schema@5.2.0

## 5.1.0

### Patch Changes

- f889ce8: `idempotency()` replays a stored response from `beforeHandle` when the route that produced it is declared after `.use(idempotency())`, so a retry passes the route's authentication, validation and earlier `beforeHandle` guards again first: a credential revoked or expired since the first request gets the route's current answer, not the stored one. The key is still claimed in `onRequest`, so an in-flight collision answers 409 as before. Stored records carry `recheck: true` for such routes; a record without it, from a route declared before the middleware or an earlier version, is replayed in `onRequest` as before.
- @nifrajs/schema@5.1.0
- 025b94d: Loop-lag shedding in `createAdmissionController` now sheds every request that arrives while the event loop is lagging, not just one per sampler tick. `createEventLoopLagSampler` used to reset its window on every read, so the first request after a stall read the lag and every request after it, until the sampler's next tick, read 0 and was admitted (1 shed, 9 admitted after a 300 ms stall). A read with no new sample since the previous one now returns that previous window's value, for both the built-in timer-drift sampler and an injected histogram.
- 56855a8: `jwks({ url })` now remembers a fetch that failed or returned an empty key set for `failureCooldownMs` (new option, default 5 s). Inside that window a request that needs the set gets the same answer at once (the fetch error, or no key) instead of starting its own fetch, and a stale set starts no new background refresh. Before, nothing was cached after a failure, so while the identity provider was down every request carrying a `kid` waited up to `timeoutMs` (5 s) on a fresh fetch. Set `failureCooldownMs: 0` for the old behavior.
- a954d67: `openapi({ ui: true })` now loads an exact Scalar build (`@scalar/api-reference` 1.72.1's `dist/browser/standalone.js` on jsDelivr) with a Subresource Integrity hash and `crossorigin="anonymous"`. Before, the page loaded the unversioned package URL with no integrity check, so whatever was published as `latest` ran on the API's own origin. A new `ui.integrity` option sets the hash for a self-hosted copy given as `ui.cdn` (which gets no hash unless you pass one), or `false` to send none.

## 5.0.0

### Major Changes

- 0aed425: Required `basicAuth`, `bearer`, `apiKey` and `jwt` refuse in the `authenticate()` stage: before the body is read or validated and before any `derive` or `beforeHandle`. An unauthenticated request gets the 401 and its challenge, never a 413 or a 422, on every route shape, lane and WebSocket handshake. With valid credentials an invalid body is still a 422. `optional: true` never refuses and keeps validation first. A `verify` that throws in required mode is a 503. A rate limiter written as a `beforeHandle` behind these guards no longer sees refused requests; `rateLimit()` runs in `onRequest` and still counts them.

  The `authenticate()` input adds `params`, the raw `search`, the parsed and frozen `query` (the parser `c.query` uses; a repeated key is an array) and the `request` (its body must not be read). The query is for short-lived, single-use tickets, such as one for a WebSocket handshake.

  Project evidence and reflection keep a route's chosen `validationOrder`.

  `nifra check` reports a route that claims runtime authentication, declares an input schema and authenticates in a hook that runs after validation (NF-S008, warning). It reads the backend the contract-lock check loads, so it runs when `contracts.lock.json` exists. Fix it with `authenticate()`, or with `validationOrder: "auth-before-validation"` on the route.

  The dev feed (`nifra_logs`, `nifra_errors`, request traces and the persisted log) records a query's keys and never its values.

### Minor Changes

- f5cd30f: `jwks()` no longer holds requests on a slow identity provider, and it picks up a rotated key before the cache expires. Inside the `staleMs` window, a request is answered from the last good key set at once while one refresh runs behind it. Before, every refresh wave waited up to `timeoutMs` while the provider hung. A token whose `kid` is missing from the cached set now refetches the set, at most once per the new `cooldownMs` option (default 30 s), so made-up `kid`s cannot turn every request into a fetch. With `staleMs: 0` every refresh is still awaited and fails closed.
- 62d73a7: A typed SSE route (`app.sse()`) is now in the OpenAPI document. Before, it was a bare `200` with no content, so a client generator for another language had nothing to build the event type from. Its `200` answers `text/event-stream`, and its event schema becomes a named component (`<operationId>Event`, or one named after the path, deduplicated) so a generator emits a type for it. `toOpenAPI(app, { openapiVersion: "3.2.0" })` (and `openapi({ openapiVersion })`) declares OpenAPI 3.2 and describes each event with the standard `itemSchema`: a `data` string whose `contentSchema` is the event schema, plus `event`, `id`, and `retry`. The default stays 3.1, which has no field for stream items, so the same schema rides as `x-itemSchema` beside `schema: { type: "string" }`. A new docs page, /docs/control-api, shows a control API built this way: methods as routes, a resumable typed event stream, the typed client, and the document for other languages.
- c6a4477: `rateLimitTiers({ store, floor, tiers })` charges each request to exactly one bucket: the tier with the longest static prefix that holds the request path, else the floor. Tiers never stack on the floor, so a tier may allow more than it. It runs before routing, so 404s, 405s and bodies that fail validation are charged; prefixes are validated when the limiter is built; each tier counts in its own store keys; and every instance has its own name, so `use()` and `merge()` never drop one. `rateLimit()` gains `skip(req, platform)`, which leaves a request uncharged and without `RateLimit-*` headers.

### Patch Changes

- eaf030b: The server records each request an authentication stage accepts, and `isAuthenticatedRequest(req)` from `@nifrajs/core/server` answers for the request response hooks receive, on every runtime and after an `onRequest` hook replaces the request. `markAuthenticatedRequest(req)` records a request an integration verified outside a stage; the optional `bearer`, `apiKey`, `jwt` and `basicAuth` guards call it. `cache()` treats a response to such a request as private, so it is stored only when the response is explicitly `public` or carries `s-maxage`, whatever header carried the credential, including an `apiKey({ header })` outside `authenticatedHeaders`.
- 7775c2b: Respect response revalidation directives and freshness when caching responses. Bypass no-cache and stale responses, cap the application TTL by max-age or s-maxage and Age, and reject old stored entries that require validation.
- d08b918: `compression()` now flushes each chunk of a streamed body as it is compressed on runtimes with `node:zlib` (Bun, Node, Deno), so a streamed page shell reaches the client before the rest of the page instead of after the whole stream closes. Runtimes without `node:zlib` keep using `CompressionStream`.
- 8606fa4: `csrf()` (middleware and auth) accepts a same-origin HTML form POST sent under `Referrer-Policy: no-referrer`, which `securityHeaders()` sets by default. Such a form arrives with `Origin: null`, and every one was refused with 403. A request with `Origin: null` now passes only when the browser's own `Sec-Fetch-Site` header says `same-origin`, and only in the default same-origin mode; an explicit `origins` allowlist still refuses it.
- 127194f: `idempotency()` no longer stores a response under the anonymous key when the request was authenticated by a credential outside `principalHeaders` (an `apiKey()` guard or an `authenticate` stage reading `x-service-key`, say). Replay runs before authentication, so an anonymous caller who presented the same `Idempotency-Key` was replayed the owner's stored response. Such requests now run each time; add the credential header to `principalHeaders` to dedupe them.
- 478daa4: `idempotency()` no longer stores request rejections (400, 404, 405, 413, 414, 415, 422, 431) for replay, alongside the statuses it already skipped. Storing them let anyone fill a `MemoryIdempotencyStore` with fresh keys sent to a route that does not exist, after which every legitimate write got 503 until the entries expired a day later. A handler that answers 400 or 422 after a side effect can keep the old behavior with its own `shouldCache`.
- 55f4fdb: `localeDetector()` and `language()` add `Vary: Accept-Language` to every response, and `localeDetector()` adds `Cookie` too when it reads a locale cookie, so a shared cache no longer serves one visitor's language to another. An existing `Vary` is extended, never replaced, and `Vary: *` is left alone.
- e370381: `basicAuth()` accepts the `Authorization` scheme in any letter case, as HTTP defines it. A client that sent `basic` or `BASIC` with valid credentials was answered 401; it is now let in, like `Basic`.
- 90d9ee6: `csrf()` publishes its route evidence for every method it guards. It guards every method but GET, HEAD and OPTIONS, custom ones included, but published evidence only for POST, PUT, PATCH and DELETE, and dropped custom methods from an explicit `methods` list. An assurance policy can now see that a custom-method route is protected.
- 0abe593: A second `healthcheck()`, `cacheControl()` or `openapi()` with its own configuration now applies alongside the first instead of being skipped as a duplicate. Applying the same instance twice still wires it once.
- 7535dfe: `negotiateContentType()` and `parseAcceptHeader()` accept the `*/*` media range that browsers, `fetch` and `curl` send, so such a request no longer matches nothing. `*/*` still ranks below a named type or `type/*`, and an invalid `*/json` is ignored.
- 7a165de: A Response returned to more than one request no longer carries one request's headers to another. A Response without a body (a module-level `new Response(null, { status: 204 })`, a kept redirect) can be sent any number of times, so the cookies a handler queues with `c.set.cookie`, the app's `responseHeaders`, and the headers written by `onResponse` hooks, response observers and response middleware go on a copy made for the request; the Response the handler returned stays as it was built. A Response with a body can be sent once: returning it again answers `500` with `{"ok":false,"error":"internal_error"}` and none of the headers written for the earlier request. On `@nifrajs/node`, a response whose body cannot be written is answered with a `500` that carries none of the headers set for it.

  `writableResponse(response, request?)`, exported from `@nifrajs/core/server`, returns the Response a request may write headers on: the response itself when it has a body and writable headers, otherwise a copy. Pass the request and a copy already made for it is reused by its later writers. `toResponse`, exported from `@nifrajs/core/edge-kit`, takes the same optional last argument: the copies and body-less responses it builds are then reused by that request's later writers instead of being copied again. A Response the handler returned is never treated as the request's own.

  `renderResult(result)`, exported from `@nifrajs/core/edge-kit`, renders a framework `ResponseResult` exactly as `toResponse` does without taking a handler's `Response`. `@nifrajs/edge` renders its rejections with it; responses are unchanged and the bundle is smaller.

- Updated dependencies [a0a02f4]
- Updated dependencies [0aed425]
- Updated dependencies [eaf030b]
- Updated dependencies [7de0397]
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
- Updated dependencies [ea16748]
- Updated dependencies [fc0284a]
- Updated dependencies [5b22f4d]
- Updated dependencies [1b94593]
- Updated dependencies [9f58295]
- Updated dependencies [62d73a7]
- Updated dependencies [b9608ac]
- Updated dependencies [7a165de]
- Updated dependencies [4064f36]
- Updated dependencies [48aad8c]
- Updated dependencies [c669308]
- Updated dependencies [2fbb4f0]
- Updated dependencies [41050ed]
- Updated dependencies [fc837cb]
- Updated dependencies [b80ce77]
- Updated dependencies [9b1acc9]
- Updated dependencies [740109f]
- Updated dependencies [e0a25fe]
- Updated dependencies [3630b6e]
- Updated dependencies [1290c6d]
- Updated dependencies [d0a7d58]
  - @nifrajs/core@5.0.0
  - @nifrajs/schema@5.0.0

## 4.0.2

### Patch Changes

- @nifrajs/schema@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/schema@4.0.1

## 4.0.0

### Minor Changes

- ff5a779: A static response header a group declares replaces the value its enclosing scopes declared for that name, on the group's routes. A value the route sets itself still wins. `securityHeaders()` takes its configuration into its plugin name, so a group's `use(securityHeaders({ ... }))` with a different configuration applies over the app's on the group's routes, where it was skipped as a repeat; the same configuration applied twice is still a no-op.
- 29c6c94: feat(middleware): client-IP default keys and a CSRF form field

  `rateLimit()` without `key`, `header`, or `trustedProxies` keys each bucket on the caller IP the
  server resolved: the socket peer, or the app's `server({ clientIp })` trust declaration behind a
  proxy. It no longer throws at construction, so the scaffolded backend templates, which pass only
  `store`, `max`, and `windowMs`, start. A request with no resolvable caller IP gets 500
  `rate_limit_key_unavailable`. A custom `key` receives the platform as its second argument.

  `ipRestriction()` without `clientIp`, `header`, or `trustedProxies` judges the same resolved caller
  IP, and denies a request that has none. A custom `clientIp` receives the platform as its second
  argument.

  Both read an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, how Bun and Node report an IPv4 peer on
  their default listener) as the IPv4 address it carries, so IPv4 `allow`/`deny` rules match it; a rule
  may also be written in that form (`::ffff:10.0.0.0/104`). `rateLimit()` counts an IPv6 caller by its
  `/64`, however the key was derived.

  `csrf({ field })` also accepts the token from a form field in an
  `application/x-www-form-urlencoded` or `multipart/form-data` body, for plain HTML forms that cannot
  set a header. Bodies over `fieldMaxBytes` (default 64 KiB) are not read for the field, file parts
  never count as the token, and the body stays readable by the route. Keep the Origin check on when
  using a field.

- d60b262: Several response middlewares are stricter about what they read and write:

  - `problemDetails()` inspects a raw error response only when it is JSON and not declared larger than `maxBytes`, so a streamed HTML error page or an endless stream is no longer read before the response is sent.
  - `prettyJson()` re-indents JSON without re-serializing it, so an integer past 2^53, `1e400`, `-0`, and string escapes reach the client exactly as written.
  - `multipartResponse()` quotes a boundary that holds a parameter delimiter (`( ) , / : = ?` or a space), so a parser reads the whole boundary.
  - `requestId()` uses an inbound id only when it is 1-200 visible ASCII characters, replacing anything else with a generated id. A new `accept` option replaces that rule.
  - `language()` reads at most the first 32 ranges of `Accept-Language`.
  - `compression()` weakens a strong `ETag` on the gzip representation, which is a different byte sequence from the one the tag named.

### Patch Changes

- 1b2d53a: `replacedRequestOf(request)` returns the request an `onRequest` hook replaced with this one. Response hooks receive the request the route ran with, so a middleware that keyed state on the request its `onRequest` saw can walk back to it. `idempotency()` uses this to keep its claim when a later hook such as `methodOverride()` rewrites the request: a retry replays the stored response instead of answering 409 and then running the handler a second time. `metrics()` uses it to count such requests and to decrement its in-flight gauge for them.
- 894f888: `csrf()` rejects a streamed form body as soon as it passes the token field limit, and cancels the request body without waiting for the stream's own cleanup. A form within the limit still reaches the handler with its body intact.
- 4936309: perf(core,node): close the realistic-route Node gap to Fastify

  The fused derive-before(-after) lifecycle lanes only had Web (`Response`-building)
  renderers, so on the Node-direct lane a derive+before route fell back to the generic
  route program while Bun rode the single closure. The same lanes now build a generic
  (finalize/wrapResponse-parameterized) fused runner that the Node dispatcher prefers
  exactly as it prefers the body-only runner - validate → derive → before → handler →
  (after) in one frame, finalizing through the caller's own outcome renderer. Semantics
  are stage-for-stage identical to the generic program (pinned by a Web-vs-Node-direct
  parity suite); Bun's fused Web lanes are untouched.

  `@nifrajs/node`'s JSON writer now emits lowercase `content-type`/`content-length`,
  matching the other Node writer paths and the Web runtimes. Proven lowercase,
  mutable records stay in place and receive framing headers without the old
  rename-and-delete dictionary-mode transition; mixed-case, frozen, and explicitly
  framed records keep the isolated normalization fallback.

  Realistic-shape bench (oha, auth + security headers + CORS + request-id + cookie,
  Node): GET 89% → 96% of Fastify, POST 94% → ~98%, body-hash 92% → 96% (each now at
  or above the raw-`node:http` ceiling).
  The Node adapter's parser-error drain guard keeps the same close-after-active-responses contract with a per-socket active counter and shared response-finish/close release listener, removing the per-request response Set while retaining close-only abort cleanup.

- 6daaa05: Each guard you build is its own plugin: `bearer()`, `basicAuth()`, `jwt()`, `ipRestriction()`, `rateLimit()`, `csrf()` and `bodyLimit()`. A second, stricter one before later routes or inside a `group()` applies alongside the first. The same instance passed to `use()` twice still applies once.
- 8e52704: fix(middleware, auth): CSRF behind TLS proxies, CORS caching, and token parsing

  The CSRF same-origin default in `csrf()` from both packages accepts an `https:` Origin on an `http:`
  request URL, which is what a TLS-terminating proxy presents. A downgrade or another host is still
  rejected.

  `cors()` with an allowlist or predicate sends `Vary: Origin` on every response, including ones that
  carry no `Access-Control-Allow-Origin`. An existing `Origin` member is not repeated, and `Vary: *` is
  kept as it is.

  `jwt()` and `verifyCsrfToken()` accept only canonical base64url signatures. `jwt()` and `bearer()`
  match the `Bearer` auth-scheme case-insensitively.

- a9923cc: `idempotency()` no longer caches a `401`, `403`, `408`, `409`, `425`, or `429` by default. Each says the operation did not run, so a retry under the same key now reaches the handler instead of replaying the refusal until the key expires. A custom `shouldCache` is unaffected.
- 7f64e2c: fix(middleware): a date-form `If-Range` in `rangeResponse()` keeps the range only when it equals the
  representation's `Last-Modified` to the second, as RFC 9110 requires. Any other date, earlier or
  later, gets the whole representation with 200.
- 027f795: `etag()` passes an event stream (`text/event-stream`) through untouched, and likewise a raw-body response marked `cache-control: no-store` or `no-transform`, instead of reading the whole body to hash it before any of it is sent. `compression()` no longer treats `text/event-stream` as compressible, so each event reaches the client as it is produced rather than waiting for the gzip window to fill.
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
- Updated dependencies [4b8d8de]
- Updated dependencies [f56b6a8]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0
  - @nifrajs/schema@4.0.0

## 3.5.0

### Patch Changes

- 6046984: Close fresh security and correctness gaps in table allowlists, ISR/cache behavior, streamed response capture, idempotency ownership, and canonical redirects.
- Updated dependencies [82c3018]
  - @nifrajs/schema@3.5.0

## 3.4.0

### Patch Changes

- Updated dependencies [719d82e]
  - @nifrajs/schema@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/schema@3.3.0

## 3.2.0

### Patch Changes

- f34a050: Record the pending source changes for these packages in their release notes so fixed-version publishing does not omit their changelog entries.
- Updated dependencies [e88c23a]
  - @nifrajs/schema@3.2.0

## 3.1.0

### Patch Changes

- 1400f6c: Portable response header, body, and raw-response observation is now enabled explicitly with `responseObserver()` from `@nifrajs/core/response-observer`. Official middleware that uses these tiers remains compatible and enables the runtime automatically.
  - @nifrajs/schema@3.1.0

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
  - @nifrajs/schema@3.0.0

## 2.14.1

### Patch Changes

- @nifrajs/schema@2.14.1

## 2.14.0

### Patch Changes

- @nifrajs/schema@2.14.0

## 2.13.0

### Patch Changes

- e0b2dd6: Harden three regex-adjacent input paths against pathological input. The byte-range parser bounds an
  oversized `Range` header before the matcher runs rather than after; the problem-details type builder
  strips trailing slashes with a linear scan instead of a backtracking pattern; and the dev SSR
  import-graph specifier pattern no longer has an ambiguous whitespace group. Behavior is unchanged for
  valid input.
  - @nifrajs/schema@2.13.0

## 2.12.1

### Patch Changes

- @nifrajs/schema@2.12.1

## 2.12.0

### Minor Changes

- 0fd146f: The default idempotency store key is now scoped by a digest of the caller's credential headers as
  well as by method + path. Presenting another caller's `Idempotency-Key` used to address their stored
  entry and replay their response; it now addresses a different key entirely. The headers that identify
  a caller are configurable via `principalHeaders` (default: Authorization, Cookie, x-api-key), and only
  a SHA-256 digest ever becomes part of a key - a raw credential as a store key would show up in every
  Redis `KEYS` dump and slow-log line. A custom `key` still replaces the scoping wholesale and must fold
  in the principal itself; it may now be async.

  `MemoryIdempotencyStore` is bounded: `maxEntries` (default 10,000) and `maxKeyBytes` (default 1024).
  Reaching the cap refuses rather than evicts - every entry is a live lock or a response someone is
  entitled to replay, so evicting to make room is how a duplicate charge happens - and the middleware
  answers `503 idempotency_unavailable` with `retry-after`. Expired entries are swept incrementally, so
  a normal request never walks the map.

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

- 59e547b: `securityHeaders` gains opt-in cross-origin isolation knobs: `crossOriginOpenerPolicy`, `crossOriginEmbedderPolicy`, `crossOriginResourcePolicy`, and `permissionsPolicy`. All remain off by default and are declared as static response headers, so the fused native lanes are preserved.
- dbc0b79: Signing-secret rotation. `signValue`/`unsignValue` (and the new `CookieSecret` type), session `secret`, and CSRF `secret` now also accept a rotation list: the first secret signs, any listed secret verifies, so keys rotate without invalidating live cookies, sessions, or CSRF tokens. Every listed secret must meet the 32-byte floor and an empty list throws; the single-secret path is unchanged.

### Patch Changes

- eb3602b: `cache()` no longer serves a stored entry to a credentialed request. The write side already refused to
  store a personalized response, but a request carrying credentials could still be answered from an
  entry stored earlier by an anonymous caller, before the route's own authentication ran. Reads now
  apply the same test as writes: a request carrying a credential header only reads an entry whose own
  `Cache-Control` marks it public (`public` or `s-maxage`). The credential headers are configurable via
  `authenticatedHeaders` and now include `x-api-key` alongside Authorization and Cookie. Routes with
  `cacheAuthenticated: true` are unaffected.
- 70ebad4: `jwt()` now verifies that a `CryptoKey` passed as the verification key actually matches the algorithm
  being verified. A key imported for one algorithm was previously used as-is for whichever `alg` the
  configuration named, so an HMAC secret could be handed to an RS256 verification (and vice versa),
  turning the algorithm choice into something the key no longer pins down. The key's `type`,
  `algorithm.name`, `algorithm.hash`, and `verify` usage must all line up, or the token is rejected with
  a JWT error. Raw string and `Uint8Array` secrets are imported by the middleware itself and were
  already bound.
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

- Updated dependencies [9a9346e]
  - @nifrajs/schema@2.12.0

## 2.11.0

### Patch Changes

- @nifrajs/schema@2.11.0

## 2.10.0

### Minor Changes

- 15bffdd: Add opt-in RFC 9457 Problem Details responses for Nifra framework errors while preserving the default error envelope.
- 15bffdd: Add standards-shaped range, conditional, content-negotiation, and multipart response helpers, plus public token-only data contracts and typed in-memory channel seams.

### Patch Changes

- @nifrajs/schema@2.10.0

## 2.9.1

### Patch Changes

- @nifrajs/schema@2.9.1

## 2.9.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [b006d07]
  - @nifrajs/schema@2.9.0

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.
  - @nifrajs/schema@2.8.2

## 2.8.1

### Patch Changes

- @nifrajs/schema@2.8.1

## 2.8.0

### Patch Changes

- @nifrajs/schema@2.8.0

## 2.7.1

### Patch Changes

- @nifrajs/schema@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/schema@2.7.0

## 2.6.1

### Patch Changes

- @nifrajs/schema@2.6.1

## 2.6.0

### Patch Changes

- @nifrajs/schema@2.6.0

## 2.5.0

### Patch Changes

- @nifrajs/schema@2.5.0

## 2.4.0

### Patch Changes

- @nifrajs/schema@2.4.0

## 2.3.0

### Minor Changes

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

### Patch Changes

- @nifrajs/schema@2.3.0

## 2.2.0

### Patch Changes

- b5f89f8: `prettyJson` no longer hangs a client on an oversized streamed JSON response.

  The middleware peeked at the body through `Response.clone()` and cancelled the clone's reader once the
  byte cap was exceeded. In Bun that cancel also stalls the original body, so a JSON response with no
  `content-length` and more than `maxBytes` of payload was passed through as a body that never completes.
  A response that should simply have skipped pretty-printing instead never finished.

  Only the cancel does this - a clone read to completion is fine - which is why every buffered response
  worked and only a streamed one failed.

  The body is now read directly and, when it proves too large, replayed: the bytes already pulled are
  re-emitted ahead of the rest of the same reader, and cancelling that stream cancels upstream. Nothing is
  buffered past the cap, and the client receives byte-for-byte what the handler produced.

  - @nifrajs/schema@2.2.0

## 2.1.0

### Patch Changes

- @nifrajs/schema@2.1.0

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
  - @nifrajs/schema@2.0.0

## 1.13.0

### Patch Changes

- @nifrajs/schema@1.13.0

## 1.12.0

### Patch Changes

- @nifrajs/schema@1.12.0

## 1.11.0

### Patch Changes

- 2dde7e5: Documentation polish for the adaptive-admission module.
  - @nifrajs/schema@1.11.0

## 1.10.0

### Patch Changes

- 92181be: Move request-deadline mechanics to the dependency-free `@nifrajs/core/budget` subpath while keeping
  `@nifrajs/budget` as a compatible re-export. Harden adaptive admission across ESM runtimes, reserved
  capacity, disconnected queued requests, and invalid capacity evidence.
  - @nifrajs/schema@1.10.0

## 1.9.1

### Patch Changes

- @nifrajs/schema@1.9.1

## 1.9.0

### Patch Changes

- @nifrajs/schema@1.9.0

## 1.8.0

### Minor Changes

- e47c4c5: Add reflection-time route assurance: middleware and plugins can publish lifecycle-accurate enforcement
  evidence, ordered policies fail closed on unclassified/missing/forbidden evidence, official hardening
  middleware emits canonical evidence, and `nifra assure` exposes a human/JSON CI gate.

### Patch Changes

- @nifrajs/schema@1.8.0

## 1.7.0

### Patch Changes

- @nifrajs/schema@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/schema@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [bd3433f]
  - @nifrajs/schema@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/schema@1.4.0

## 1.3.1

### Patch Changes

- @nifrajs/schema@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [4a4b1c4]
  - @nifrajs/schema@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/schema@1.2.2

## 1.2.1

### Patch Changes

- @nifrajs/schema@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/schema@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [17e57c4]
  - @nifrajs/schema@1.1.0

## 1.0.0

### Minor Changes

- de9675b: Pre-1.0 security hardening pass. A framework-wide audit found no critical/high issues; these close the medium/low items it surfaced.

  - **`cache()` - no cross-user leak by default.** A `200` to a request bearing `Authorization`/`Cookie` is no longer stored (and replayed to other users) unless the response is explicitly `Cache-Control: public`/`s-maxage` (RFC 9111 §3.5). Opt back in per cache with `cacheAuthenticated: true` for a route that's identical for every caller.
  - **`idempotency()` - route-scoped keys + a `key` hook.** The default store key is now scoped by method+path, so the same `Idempotency-Key` on a different endpoint can't collide and replay another resource's response. Added a `key(req, header)` option to scope by principal (e.g. user id). Method matching normalized to upper-case.
  - **`etag()` - a `304` no longer carries the `200`'s `Content-Length`/`Content-Type`.**
  - **`@nifrajs/core` - inbound WebSocket frames are capped** when serving on Bun (`listen()`): frames over `wsMaxPayloadBytes` (default `maxBodyBytes`, 1 MB) are rejected by the runtime before reaching a handler, so a huge frame can't be buffered/parsed into memory. New `ServerOptions.wsMaxPayloadBytes`.
  - **`@nifrajs/core` - WebSocket routes are same-origin by default (CSWSH).** A `ws()` route with no `allowedOrigins` now rejects a **cross-origin browser** handshake (an `Origin` whose host differs from the request's) with `403` - closing cross-site WebSocket hijacking, since browsers send cookies on WS handshakes and don't apply CORS. Non-browser clients (no `Origin`) and same-origin browsers are unaffected. **Breaking** for a route that served a cross-origin browser without declaring `allowedOrigins`: set `allowedOrigins` to the permitted origins (or `() => true` for a genuinely public socket).
  - **`@nifrajs/node` - static file handler** now adds `X-Content-Type-Options: nosniff` and re-checks the real path (symlink containment) before streaming, matching the image server.
  - **`@nifrajs/mcp` - widget bridge** now rejects `postMessage` events whose source isn't the parent window (including null-source synthetic events), closing a spoofing gap the previous guard left open.
  - **`@nifrajs/cli` - the MCP `nifra_run`/`nifra_ws` `entry` arg** is kept inside the project root, so a crafted `entry` can't import/execute a module outside the project.

### Patch Changes

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/core@1.0.0
  - @nifrajs/schema@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/core@1.0.0-beta.4
- @nifrajs/schema@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/core@1.0.0-beta.3
- @nifrajs/schema@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- @nifrajs/core@0.1.0-beta.2
- @nifrajs/schema@0.1.0-beta.2
