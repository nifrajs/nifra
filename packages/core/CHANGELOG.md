# @nifrajs/core

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
