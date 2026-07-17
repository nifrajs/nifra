# nifra API reference (generated)

Every public export of every package and documented subpath — name, kind, signature, and doc summary — extracted from each package's `exports` map with the TypeScript compiler API, so it cannot drift from the code. For HTTP route shapes (request/response bodies), see the OpenAPI + Scalar reference your app serves at `/reference`. For prose guides, see `llms-full.txt`.

## @nifrajs/agent-telemetry

- **AgentTelemetryOptions** _(interface)_ — `interface AgentTelemetryOptions`
- **agentTelemetry** _(function)_ — `agentTelemetry: (options: AgentTelemetryOptions) => { name: string; beforeHandle(context: HookContext): undefined; onError(error: unknown, context: HookContext): undefined; onResponse(response: Response, request: Reques…`
  Agent telemetry middleware. Register via `app.use(agentTelemetry({ exporter }))`.
- **consoleAgentExporter** _(function)_ — `consoleAgentExporter: (log?: (line: string) => void) => ObservationAdapter`
  Pretty-prints agent tool call traces to the terminal.

## @nifrajs/auth

- **CsrfOptions** _(interface)_ — `interface CsrfOptions`
- **GuardOptions** _(interface)_ — `interface GuardOptions`
  What a guard does when the check fails: 302 to `redirectTo` (a same-origin path), or — omitted — a 401 JSON (`{ ok: false, error: "unauthorized" }`).
- **KVNamespaceLike** _(interface)_ — `interface KVNamespaceLike`
  Minimal structural shape of a Cloudflare Workers **KV namespace** binding — just the three methods {@link KVSessionStore} uses. Structural (no `@cloudflare/workers-types` dependency) so any KV-like binding satisfies it and tests can pass an in-memory double.
- **KVSessionStore** _(class)_ — `class KVSessionStore`
  A {@link SessionStore} backed by a **Cloudflare Workers KV** namespace (or any {@link KVNamespaceLike}) — the durable, shared production store: sessions hold across worker instances and survive restarts. Records serialize to JSON; the entry's KV `expiration` is set from the record's `expiresAt` so …
- **MemorySessionStore** _(class)_ — `class MemorySessionStore`
  In-process session store. Refuses to run in production unless explicitly allowed (mirrors the ISR `MemoryCacheStore` + the rate-limit `MemoryStore` — a per-instance store is unsafe across instances). Bounded: oldest-inserted entries evict past `max`.
- **MemorySessionStoreOptions** _(interface)_ — `interface MemorySessionStoreOptions`
- **Session** _(interface)_ — `interface Session<Data extends Record<string, unknown> = Record<string, unknown>>`
  A typed session handle. Every key is optional — a fresh session is empty.
- **SessionContext** _(interface)_ — `interface SessionContext`
  The cookie + response surface the manager needs — a structural subset of nifra's `Context`, so any `c` satisfies it and it's testable with a stub.
- **SessionCookieOptions** _(type)_ — `type SessionCookieOptions = Pick<CookieOptions, "secure" | "sameSite" | "path" | "domain">`
  Cookie attributes a session may tune. `httpOnly` is **not** offered — a session cookie is always HttpOnly; `maxAge`/`expires` are derived from the session's lifetime.
- **SessionManager** _(interface)_ — `interface SessionManager<Data extends Record<string, unknown> = Record<string, unknown>>`
- **SessionOptions** _(interface)_ — `interface SessionOptions`
- **SessionRecord** _(interface)_ — `interface SessionRecord`
  A persisted session — its data plus an absolute expiry (ms epoch).
- **SessionStore** _(interface)_ — `interface SessionStore`
  Pluggable session backend (store mode). Async so a network store (KV/Redis) fits the same shape. **Production needs a shared/durable store** so sessions hold across instances — {@link MemorySessionStore} prod-guards against the per-instance footgun.
- **createSessions** _(function)_ — `createSessions: <Data extends Record<string, unknown> = Record<string, unknown>>(options: SessionOptions) => SessionManager<Data>`
- **csrf** _(function)_ — `csrf: (options?: CsrfOptions) => Middleware`
- **requireSession** _(function)_ — `requireSession: <Data extends Record<string, unknown>>(session: Session<Data>, options?: GuardOptions) => Session<Data>`
  Require a non-empty session. Returns it when present; otherwise throws a `Response` (302/401). Use at the top of a protected loader: `const session = requireSession(await sessions.get(c), { redirectTo: "/login" })`.
- **requireUser** _(function)_ — `requireUser: <Data extends Record<string, unknown>, K extends keyof Data>(session: Session<Data>, key: K, options?: GuardOptions) => NonNullable<Data[K]>`
  Require a specific session key (e.g. the `userId` a login set) to be present. Returns its value (narrowed non-nullish); otherwise throws like {@link requireSession}. The common "who is the user" guard: `const userId = requireUser(await sessions.get(c), "userId", { redirectTo: "/login" })`.

## @nifrajs/better-auth

- **AuthedOptions** _(interface)_ — `interface AuthedOptions<User>`
  Options for {@link requirePrincipal} / {@link authed}.
- **BetterAuthLike** _(interface)_ — `interface BetterAuthLike`
  The structural slice of a [better-auth](https://better-auth.com) instance this package needs. Declared structurally rather than imported, so `@nifrajs/better-auth` has **no runtime dependency** on better-auth: you pass your own `auth` object and its concrete types flow through {@link getSession} / …
- **BetterAuthOptions** _(interface)_ — `interface BetterAuthOptions`
- **Principal** _(interface)_ — `interface Principal<User>`
  The authenticated caller of a request, mapped from a better-auth session. Built by {@link requirePrincipal} / {@link authed} and threaded onto the handler context as `c.principal`.
- **PrincipalFor** _(type)_ — `type PrincipalFor<User, RequireTenant extends boolean> = RequireTenant extends true ? Principal<User> & { readonly tenantId: string } : Principal<User>`
  The principal type for a given `requireTenant` flag: `tenantId` narrows to a required `string` when `requireTenant` is `true`, otherwise stays optional (`string | undefined`). The flag is captured as a literal `const` type parameter at the call sites so `{ requireTenant: true }` selects the narrowe…
- **RequireSessionOptions** _(interface)_ — `interface RequireSessionOptions`
  What {@link requireSession} does on a missing session: `302` to `redirectTo` (a same-origin path), or — when omitted — a `401` JSON (`{ ok: false, error: "unauthorized" }`). Mirrors `@nifrajs/auth` guards.
- **SessionOf** _(type)_ — `type SessionOf<A extends BetterAuthLike> = NonNullable< Awaited<ReturnType<A["api"]["getSession"]>> >`
  The non-null session payload of a concrete better-auth instance `A`, inferred from its `api.getSession` return type (typically `{ user: User; session: Session }`).
- **SessionUserOf** _(type)_ — `type SessionUserOf<A extends BetterAuthLike> = SessionOf<A> extends { user: infer U } ? U : unknown`
  The non-null user type of a concrete better-auth instance `A` (`SessionOf<A>["user"]`). Collapses to `unknown` only for the erased structural `BetterAuthLike`; a real instance recovers the concrete user.
- **WithPrincipal** _(type)_ — `type WithPrincipal<S extends AnyServer, P> = S extends Server<infer R, infer C> ? Server<R, C & { principal: P }> : never`
  Add `{ principal: P }` to a server's context while preserving its route registry `R` (no collapse to `any`). This is the type that makes `.use(authed(auth))` thread a NON-NULL `c.principal`.
- **authed** _(function)_ — `authed: <A extends BetterAuthLike, const RequireTenant extends boolean = false>(auth: A, options?: AuthedOptions<SessionUserOf<A>> & { readonly requireTenant?: RequireTenant; }) => <S extends AnyServer>(app: S) => WithP…`
  A nifra plugin that derives a fail-closed {@link Principal} onto every downstream handler as `c.principal`. After `server().use(authed(auth))`, `c.principal.user` / `c.principal.userId` are typed and **non-null** — a handler CANNOT run without an authenticated caller, so the guard can't be forgotte…
- **betterAuth** _(function)_ — `betterAuth: (auth: BetterAuthLike, options?: BetterAuthOptions) => import("@nifrajs/core").IdentityPlugin`
  Mount a better-auth instance into a nifra app: registers its handler at `${basePath}/*` (default `/api/auth/*`) for `GET` + `POST`, so every better-auth endpoint — sign-in/up/out, OAuth callbacks, session, 2FA, magic links, … — is served by your nifra server.
- **getSession** _(function)_ — `getSession: <A extends BetterAuthLike>(auth: A, request: Request) => Promise<SessionOf<A> | null>`
  Resolve the better-auth session for a request — a thin, typed wrapper over `auth.api.getSession`. Returns `null` when unauthenticated. Takes the raw `Request` so it works in both server handlers (`c.req`) and web loaders/actions (`request`).
- **requirePrincipal** _(function)_ — `requirePrincipal: <A extends BetterAuthLike, const RequireTenant extends boolean = false>(auth: A, request: Request, options?: AuthedOptions<SessionUserOf<A>> & { readonly requireTenant?: RequireTenant; }) => Promise<Pr…`
  Resolve the better-auth session and map it to a {@link Principal}, or **throw a `Response`** so the handler never runs unauthenticated:
- **requireSession** _(function)_ — `requireSession: <A extends BetterAuthLike>(auth: A, request: Request, options?: RequireSessionOptions) => Promise<SessionOf<A>>`
  Require an authenticated better-auth session at the top of a protected handler/loader/action. Returns the (non-null) session when present; otherwise **throws a `Response`** (302/401) — nifra returns a thrown `Response` as-is, short-circuiting the rest of the handler.

## @nifrajs/cache

- **Cache** _(interface)_ — `interface Cache`
- **CacheOptions** _(interface)_ — `interface CacheOptions`
- **CacheStore** _(interface)_ — `interface CacheStore`
  Raw key→entry storage. The default {@link MemoryCache} is in-process; implement this over CF KV / Redis / etc. for a cache shared across instances. All methods may be sync or async — the cache awaits them.
- **MemoryCache** _(class)_ — `class MemoryCache`
- **MemoryCacheOptions** _(interface)_ — `interface MemoryCacheOptions`
- **SetOptions** _(interface)_ — `interface SetOptions`
- **StoredEntry** _(interface)_ — `interface StoredEntry`
  A cached entry as the store holds it.
- **WrapOptions** _(type)_ — `type WrapOptions = SetOptions`
- **createCache** _(function)_ — `createCache: (options?: CacheOptions) => Cache`
  Create a cache over the given (or a fresh in-memory) store.

## @nifrajs/cli

- **Example** _(interface)_ — `interface Example`
- **McpHttpOptions** _(interface)_ — `interface McpHttpOptions`
- **TypeEntry** _(interface)_ — `interface TypeEntry`
- **default** _(const)_ — `default: { port: number; fetch: (request: Request) => Promise<Response>; }`
  Worker/edge + local entry. `export default { fetch }` is the universal server shape: Cloudflare / Vercel edge / Deno deploy use `fetch` (and ignore `port`); `bun run mcp-http.ts` auto-serves it on `port` (PORT env, default 8787) — Bun serves a module's default-exported server, so NO manual `Bun.ser…
- **docsTools** _(function)_ — `docsTools: (loadDocs: () => Promise<string | undefined>, loadExamples: () => Promise<Example[] | undefined>, loadTypes: () => Promise<TypeEntry[] | undefined>) => McpTool[]`
  Build `nifra_docs` + `nifra_example` + `nifra_types` over injected corpus loaders.
- **handleMcpHttp** _(function)_ — `handleMcpHttp: (request: Request) => Promise<Response>`
  The CLI HTTP handler: serves the disk-backed corpus tools. (`nifra docs-mcp` / `bun run` this file.)
- **publicDocsTools** _(function)_ — `publicDocsTools: () => McpTool[]`
  The two project-independent tools, reading the package's bundled corpus from disk (CLI use).
- **respondMcpHttp** _(function)_ — `respondMcpHttp: (request: Request, tools: McpTool[], options?: McpHttpOptions) => Promise<Response>`
  Handle one MCP request against the given `tools` with the docs server identity. A thin docs-flavored wrapper over the shared {@link respondMcpHttpCore} so the `@nifrajs/cli/mcp` self-host surface keeps its `(request, tools, options?)` shape (the site's edge worker calls it with two args).

## @nifrajs/client

- **ActionArgs** _(type)_ — `type ActionArgs<Api, Env = unknown> = LoaderArgs<Api, Env>`
  Context a route `action` (a mutation, run on POST) receives — identical to a loader's: route params, the request (read the form/JSON body off this), and the typed in-process `api` + platform `env`. An action returns either data (surfaced to the page as `actionData`) or a `Response` (e.g. a `redirec…
- **ActionData** _(type)_ — `type ActionData<A> = A extends (...args: never[]) => infer R ? Awaited<R> extends { readonly __nifraRevalidate: readonly string[]; readonly data: infer D } ? Exclude<D, Response> : Exclude<Awaited<R>, Response> : never`
  The (awaited) data return of an `action`, for typing a page component's `actionData` prop. A `Response` return (redirect/custom) is excluded — it never reaches the component. A `revalidate(paths, data)` wrapper (from `@nifrajs/web`) is transparent: matched structurally (so this stays decoupled from…
- **ApiError** _(interface)_ — `interface ApiError`
  A structured API error, mirroring the server's `{ ok: false, error, issues }`.
- **ApiProxy** _(type)_ — `type ApiProxy<Api> = Api extends ContractShape ? TreatyFromRegistry<RegistryFor<Api>> : Treaty<Api>`
  The typed client proxy for an API type — either a server type (`typeof app`, coupled) or a contract value type (decoupled). Graduating a loader from `typeof app` to a versioned contract is just changing this one type argument; the loader body is identical.
- **ClientOptions** _(interface)_ — `interface ClientOptions`
- **ClientRetryOptions** _(interface)_ — `interface ClientRetryOptions`
  Safe retry policy. Off unless `retry` is set; retries ONLY idempotent methods and transient 5xx — never a 4xx/429 and never a non-idempotent method, so a retry can't double a side effect.
- **FetchFn** _(type)_ — `type FetchFn = (input: string, init?: RequestInit) => Promise<Response>`
  The fetch shape the client needs — looser than `typeof fetch` so an in-process bridge or a test mock satisfies it without the extra members (`.preconnect`, overloads) of the global.
- **InProcessClient** _(type)_ — `type InProcessClient<App> = Treaty<App> & BackendMount`
  Typed route client plus the explicit platform-aware backend mount capability.
- **InProcessClientOptions** _(interface)_ — `interface InProcessClientOptions`
- **Jsonify** _(type)_ — `type Jsonify<T>`
  Maps a value to the shape it takes after a JSON round-trip, so the client's `data` type reflects the wire — not the handler's in-memory return.
- **LoaderArgs** _(interface)_ — `interface LoaderArgs<Api, Env = unknown>`
  Context a route `loader` receives: the route params, the request, a typed in-process `api` (an {@link ApiProxy} for the app contract `Api`), and the platform `env`. Pair with `inProcessClient`.
- **LoaderData** _(type)_ — `type LoaderData<L> = L extends (...args: never[]) => infer R ? Awaited<R> : never`
  The (awaited) return of a `loader`, for typing a page component's `data` prop.
- **RegistryOf** _(type)_ — `type RegistryOf<App> = App extends Server<infer R, infer _Ctx> ? R : never`
  Extract the accumulated route registry from a server's type (`typeof app`), ignoring its middleware context.
- **ResponseContractViolation** _(class)_ — `class ResponseContractViolation`
  A response body that broke its route's declared contract. Thrown THROUGH the "never throws" client on purpose: this is a test assertion about the server's honesty, not a call outcome the caller should branch on - swallowing it into a `Result` would let the drift pass the test.
- **Result** _(type)_ — `type Result<Data, Errors = unknown>`
  The outcome of a client call. The client never throws - inspect `ok` to branch.
- **SubscribeOptions** _(interface)_ — `interface SubscribeOptions<I extends RouteInfo>`
- **Subscription** _(interface)_ — `interface Subscription`
- **Treaty** _(type)_ — `type Treaty<App> = TreatyFromRegistry<RegistryOf<App>>`
  The Eden-style proxy type for a server. Use a named alias for readable errors:
- **TreatyFromRegistry** _(type)_ — `type TreatyFromRegistry<R> = TreatyNode<R, ""> & RootIndex<R>`
  The Eden-style proxy type for a route registry — the shared core used by both `Treaty<App>` (coupled, from `typeof app`) and `client(contract, url)` (decoupled, from a contract's `RegistryFor`).
- **WsCallOptions** _(interface)_ — `interface WsCallOptions`
- **WsHandle** _(interface)_ — `interface WsHandle<In, Out>`
  A live typed WebSocket connection to an `app.ws()` route. `send` accepts the route's `messageSchema` input type (validated server-side at the trust boundary); received frames are typed from its `sendSchema` and JSON-parsed. Binary frames are not part of the typed contract and are ignored by `messag…
- **client** _(function)_ — `client: { <App>(baseUrl: string, options?: ClientOptions): Treaty<App>; <const C extends ContractShape>(contract: C, baseUrl: string, options?: ClientOptions): TreatyFromRegistry<RegistryFor<C>>; }`
  Create an end-to-end-typed client for a nifra server. Two modes:
- **inProcessClient** _(function)_ — `inProcessClient: <App extends { fetch(request: Request): Response | Promise<Response>; }>(app: App, options?: InProcessClientOptions) => InProcessClient<App>`
  A {@link client} whose `fetch` calls a nifra app's own `fetch` in-process — no network, full lifecycle (validation, middleware, contracts). For SSR loaders. Typed from `App` exactly like the network client. The `(url, init) → Request` bridge is required because the client calls `fetch(url, init)` w…
- **testClient** _(const)_ — `testClient: <App extends { fetch(request: Request): Response | Promise<Response>; }>(app: App, options?: InProcessClientOptions) => InProcessClient<App>`
  The in-process test client — the Fastify-`inject` / supertest equivalent for nifra. Drives the app's own `fetch` directly: no server, no port, no network, the full real lifecycle (validation, middleware, contracts, auth), and end-to-end types from `App`. Calls never throw — branch on `res.ok`. An a…

## @nifrajs/content

### `@nifrajs/content`

- **BakedCollection** _(interface)_ — `interface BakedCollection<Frontmatter>`
  A content collection baked to plain data — fs-free, so it works at the **edge** (Workers request-time) where `defineCollection`'s `node:fs` reader can't run. Produce one at build/server time with `bakeCollection`, JSON-serialize + ship it in the bundle, then rehydrate with `fromBaked`.
- **Entry** _(interface)_ — `interface Entry<Frontmatter>`
  A parsed content entry: its slug, validated frontmatter, rendered HTML, and the raw Markdown body.
- **InferSchema** _(type)_ — `type InferSchema<S> = S extends StandardSchemaV1<infer Output> ? Output : never`
  The validated output type of a schema.
- **ParseEntryOptions** _(interface)_ — `interface ParseEntryOptions<S extends StandardSchemaV1>`
- **StandardSchemaV1** _(interface)_ — `interface StandardSchemaV1<Output = unknown>`
  Minimal [Standard Schema](https://standardschema.dev) shape — lets frontmatter validate against any compliant validator (`@nifrajs/schema`'s `t`, zod, valibot, …) without coupling `@nifrajs/content` to one.
- **StaticCollection** _(interface)_ — `interface StaticCollection<Frontmatter>`
  Read-only collection surface (`all()`/`get()`) — structurally compatible with `defineCollection`'s `Collection`, but with no filesystem access.
- **bakeCollection** _(function)_ — `bakeCollection: <Frontmatter>(collection: { all(): Promise<ReadonlyArray<Entry<Frontmatter>>>; }) => Promise<BakedCollection<Frontmatter>>`
  Bake a collection's entries to serializable data at build/server time. The collection does the filesystem read + validation (via `all()`); this just collects the already-parsed result so it can be JSON-serialized into the edge bundle. Pure — safe to import anywhere.
- **fromBaked** _(function)_ — `fromBaked: <Frontmatter>(baked: BakedCollection<Frontmatter>) => StaticCollection<Frontmatter>`
  Rehydrate a baked collection into a read-only `all()`/`get()` collection — fs-free, edge-safe. The entries were validated when baked (build output, trusted), so they're served as-is. `get` is O(1).
- **parseEntry** _(function)_ — `parseEntry: <S extends StandardSchemaV1>(options: ParseEntryOptions<S>) => Promise<Entry<InferSchema<S>>>`
  Parse one content file: split + validate its frontmatter against `schema`, render its Markdown body to HTML. Throws a descriptive error (naming the slug + the issues) when the frontmatter is invalid — surface it at build/load time rather than shipping a malformed entry. Pure + edge-safe.
- **parseFrontmatter** _(function)_ — `parseFrontmatter: (raw: string) => { data: unknown; body: string; }`
  Split a raw content string into its (unvalidated) frontmatter data + the body. No frontmatter block ⇒ `data` is `{}` and `body` is the whole input.

### `@nifrajs/content/fs`

- **Collection** _(interface)_ — `interface Collection<Frontmatter>`
  A typed collection over a content directory.
- **CollectionConfig** _(interface)_ — `interface CollectionConfig<S extends StandardSchemaV1>`
- **defineCollection** _(function)_ — `defineCollection: <S extends StandardSchemaV1>(config: CollectionConfig<S>) => Collection<InferSchema<S>>`
  Define a content collection backed by a directory. `all()` discovers + parses every matching file; `get(slug)` loads one. Frontmatter is validated against `schema`, so entries are fully typed and a malformed file fails loudly. Reads the filesystem — use it at build time (SSG/prerender) or on a long…

### `@nifrajs/content/mdx`

- **MdxPluginOptions** _(interface)_ — `interface MdxPluginOptions`
- **mdxBunPlugin** _(function)_ — `mdxBunPlugin: (options?: MdxPluginOptions) => BunPlugin`
  Build a `Bun.build` plugin that loads `.mdx` files as compiled components. The compiled module's default export is the MDX content component; `.mdx` files may `import` and use components inline and `export const meta = …` like any route module.

## @nifrajs/core

### `@nifrajs/core`

- **AdmissionController** _(interface)_ — `interface AdmissionController`
  A capacity-admission gate. Decides, per request, whether the instance has capacity to run it now - bounding *concurrency*, which rate limits (frequency) and deadlines (duration) do not. Provide an implementation (see `@nifrajs/middleware`'s `createAdmissionController`) as {@link ServerOptions.admis…
- **AdmissionDecision** _(type)_ — `type AdmissionDecision = | { readonly admitted: true; release(): void } | { readonly admitted: false; readonly response: Response }`
  The outcome of a capacity-admission decision. `admitted` requests carry a `release` the server calls exactly once when the response is finalized; a shed request carries a ready `429` Response.
- **AnyServer** _(type)_ — `type AnyServer = Server<any, any>`
- **Context** _(interface)_ — `interface Context<Path extends string = string, S extends RouteSchema = RouteSchema>`
  Handler context. `params` are inferred from the path; `body` and `query` are the validated outputs of their schemas when declared (else `undefined` / raw `URLSearchParams`).
- **CookieOptions** _(interface)_ — `interface CookieOptions`
  Attributes for a `Set-Cookie`. `expires` is a `Date`; `maxAge` is in **seconds**.
- **DurableObjectNamespaceLike** _(interface)_ — `interface DurableObjectNamespaceLike`
  Structural view of a Cloudflare Durable Object namespace binding — keeps `@cloudflare/workers-types` out of `@nifrajs/core`. The real `DurableObjectNamespace` satisfies it.
- **ExecutionContext** _(interface)_ — `interface ExecutionContext`
  A Cloudflare Workers-style execution context (the `fetch` 3rd arg). Structural — only `waitUntil` is used; declared here so `@nifrajs/core` needs no Workers type dependency.
- **FRAMEWORK_NAME** _(const)_ — `FRAMEWORK_NAME: "Nifra"`
  Single source of truth for the framework's user-facing name.
- **FrameworkError** _(class)_ — `class FrameworkError`
  Base class for every error the framework throws. Carries a stable, string `code` so callers can branch on the failure programmatically rather than matching on message text. Messages are prefixed with the brand name.
- **FrameworkName** _(type)_ — `type FrameworkName = typeof FRAMEWORK_NAME`
- **Handler** _(type)_ — `type Handler<Path extends string, S extends RouteSchema = RouteSchema, Ctx = EmptyContext> = (ctx: Context<Path, S> & Ctx) => MaybePromise<ResponseOf<S>>`
  Public handler shape: context typed from the path, the (optional) schema, and any accumulated middleware context `Ctx` (from `derive`/`decorate`).
- **IdentityPlugin** _(type)_ — `type IdentityPlugin = (<S extends AnyServer>(app: S) => S) & { readonly pluginName?: string }`
  A named type-identity plugin built with {@link defineIdentityPlugin}. It returns the same concrete server type it receives, preserving the caller's typed registry and context across `.use()` while still allowing the plugin to register runtime hooks or handlers.
- **InferInput** _(type)_ — `type InferInput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["input"]`
- **InferOutput** _(type)_ — `type InferOutput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["output"]`
- **LogFields** _(type)_ — `type LogFields = Record<string, unknown>`
  Structured, redacting logger. The framework logs through this interface so secrets/PII are scrubbed once, centrally (per the project's logging rule), not at each call site. Bring your own by passing `logger` to `server()`.
- **Logger** _(interface)_ — `interface Logger`
- **METHODS** _(const)_ — `METHODS: readonly ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]`
  HTTP methods the router accepts.
- **McpPromptDescriptor** _(interface)_ — `interface McpPromptDescriptor`
  An app-declared MCP prompt - a reusable prompt template an agent can fetch through `nifra mcp`.
- **McpResourceDescriptor** _(interface)_ — `interface McpResourceDescriptor`
  An app-declared MCP resource - read-only data an agent can fetch through `nifra mcp`.
- **Method** _(type)_ — `type Method = (typeof METHODS)[number]`
- **Middleware** _(interface)_ — `interface Middleware`
  A bundle of lifecycle hooks applied together via {@link Server.use} - the unit `@nifrajs/middleware` ships (cors, security headers, rate-limit). Every hook is optional and wired to its lifecycle point. Middleware is context-agnostic (sees the base `Context`); `use` does no context-type merging - th…
- **NifraPlugin** _(type)_ — `type NifraPlugin<In extends AnyServer = AnyServer, Out extends AnyServer = In> = (( app: In, ) => Out) & { readonly pluginName?: string }`
  A nifra **plugin**: a function that augments an app - calling `use`/`derive`/`decorate` and/or registering routes - and returns it. Because `derive`/`decorate` are type-threaded, an **inline** `app.use((a) => a.derive(...).decorate(...))` carries the added context to handlers defined after it (the …
- **NifraWebSocket** _(interface)_ — `interface NifraWebSocket<Data = unknown>`
  The portable socket handed to WS lifecycle callbacks. Each adapter wraps its native socket.
- **NodeServeOutcome** _(type)_ — `type NodeServeOutcome`
  What {@link Server.resolveNode} returns: either a plain-data render the `@nifrajs/node` adapter writes to the socket directly (`kind: "json"` - status + headers + cookies + a pre-stringified body, **no** undici `Response` built or drained), a marked buffered response body (`kind: "body"` - e.g.
- **OnRequestResult** _(type)_ — `type OnRequestResult = Response | Request | undefined`
- **Params** _(type)_ — `type Params<Path extends string> = Prettify<RawParams<Path>>`
- **Platform** _(interface)_ — `interface Platform<Env = unknown>`
  Runtime platform inputs, passed as `app.fetch(request, platform)`. Edge adapters (e.g. Cloudflare Workers) supply `env` (bindings) + `waitUntil`; Bun/Node/Deno omit them. Optional + runtime-neutral, so `app.fetch` stays a Web-standard handler.
- **Prettify** _(type)_ — `type Prettify<T> = { [K in keyof T]: T[K] } & {}`
  Flattens an intersection into a single object type for readable hovers.
- **PromptArgument** _(interface)_ — `interface PromptArgument`
  One declared argument of an MCP prompt, surfaced in `prompts/list`.
- **PromptMessage** _(interface)_ — `interface PromptMessage`
  A message in an MCP prompt's rendered output (see {@link Server.prompt}).
- **RedactOptions** _(interface)_ — `interface RedactOptions`
  Tunes redaction. Key-name redaction always runs; the rest is **opt-in**: - `keyParts` — extra case-insensitive key fragments, added to the built-in denylist. - `valuePatterns` — regexes matched against string **values** *and* the log message; each match is replaced with the placeholder. This is the…
- **Registry** _(type)_ — `type Registry = Record<string, Record<string, RouteInfo>>`
  The accumulated, type-level map of every route on a Server: path → method → RouteInfo.
- **ResponseControls** _(interface)_ — `interface ResponseControls`
  Mutable response controls a handler may write to before returning.
- **ResponseFinalization** _(interface)_ — `interface ResponseFinalization`
  The terminal response-pipeline outcome observed after every transforming `onResponse` hook.
- **RouteConfigError** _(class)_ — `class RouteConfigError`
  Thrown at route registration when a route is misconfigured. This is the boot-time rejection layer: loud and early, never deferred to the first request.
- **RouteConfigErrorCode** _(type)_ — `type RouteConfigErrorCode = | "DUPLICATE_ROUTE" | "DUPLICATE_PARAM" | "PARAM_NAME_CONFLICT" | "INVALID_PATH" | "INVALID_PARAM_NAME" | "WILDCARD_NOT_LAST" | "INVALID_METHOD" | "INVALID_ASSURANCE" | "INVALID_IDEMPOTENCY"`
  Stable codes for boot-time (L2) route configuration failures.
- **RouteDescriptor** _(interface)_ — `interface RouteDescriptor`
  A registered route's public descriptor - method, path, and input schemas. The router trie discards the original patterns, so this flat list is what lets tools (e.g. `toOpenAPI`) enumerate routes after registration.
- **RouteInfo** _(interface)_ — `interface RouteInfo`
  One route's input/output shape as the **client** will consume it. `query`/`body` are `never` when the route declares no schema for them, so the client can detect "this route takes no body" via `[body] extends [never]`. `output` is the handler's raw return type (the client applies `Jsonify` when rea…
- **RouteSchema** _(interface)_ — `interface RouteSchema`
  Per-route input schemas. Each is any Standard Schema (zod/valibot/arktype/…).
- **Router** _(class)_ — `class Router<T>`
  Radix-style segment trie router. Matching precedence is static > param > wildcard. Parameter/wildcard values are returned RAW (not percent-decoded); the server boundary decodes and rejects malformed encodings with a 400, keeping this layer pure and allocation-light.
- **RouterMatch** _(type)_ — `type RouterMatch<T>`
  Result of {@link Router.find}. The `found: false` cases deliberately separate a missing path (404) from a path that exists for other methods (405), so the server layer can answer correctly and populate an `Allow` header.
- **RunningServer** _(interface)_ — `interface RunningServer`
  The handle `listen()` returns - the slice of Bun's server nifra holds and exposes. Declared explicitly (rather than `ReturnType<typeof Bun.serve>`) so the public type surface doesn't leak the ambient `Bun` global into consumers' `.d.ts` resolution.
- **SSEContext** _(interface)_ — `interface SSEContext`
  Minimal context shape `sse` needs — the live request, for its client-disconnect signal.
- **SSEInit** _(interface)_ — `interface SSEInit`
- **SSEMessage** _(interface)_ — `interface SSEMessage`
  One SSE frame. Every field is optional; `data` may be multi-line (emitted as multiple `data:` lines).
- **SSEStream** _(interface)_ — `interface SSEStream`
  The stream handed to the `run` callback.
- **ScheduledController** _(interface)_ — `interface ScheduledController`
  A Cloudflare Workers-style scheduled (cron) controller. Structural — no Workers type dependency.
- **ScheduledHandler** _(type)_ — `type ScheduledHandler<Env = unknown> = ( controller: ScheduledController, context: { readonly env: Env; waitUntil(promise: Promise<unknown>): void }, ) => MaybePromise<void>`
  A nifra cron handler: the platform controller + the same typed `env`/`waitUntil` nifra threads into request handlers. Schedule background work with `waitUntil` so it outlives the trigger.
- **Server** _(class)_ — `class Server<R extends Registry = EmptyRegistry, Ctx = EmptyContext>`
  The inline server. Routes are chainable and fully type-inferred. `derive`/ `decorate` extend the handler context (`Ctx`) for routes defined *after* them, with full types; `Ctx` is server-only and never touches the client registry.
- **ServerOptions** _(interface)_ — `interface ServerOptions`
- **StandardIssue** _(interface)_ — `interface StandardIssue`
- **StandardResult** _(type)_ — `type StandardResult<Output> = StandardSuccess<Output> | StandardFailure`
- **StandardSchemaV1** _(interface)_ — `interface StandardSchemaV1<Input = unknown, Output = Input>`
  The Standard Schema v1 interface (https://standardschema.dev), vendored as types + a tiny runtime helper so any compliant validator — zod, valibot, arktype, … — validates requests without coupling the framework to one lib. The spec is MIT-licensed and explicitly designed to be copied.
- **StandardTypes** _(interface)_ — `interface StandardTypes<Input = unknown, Output = Input>`
- **StandardWebSocket** _(interface)_ — `interface StandardWebSocket`
  A standard server-side `WebSocket` — the half returned by Deno's `Deno.upgradeWebSocket` and the Workers `WebSocketPair`. {@link attachWebSocket} wires one to a nifra handler, so the Deno and Workers bridges share all the dispatch/normalization/error-isolation logic (only the upgrade call differs).
- **ToolAnnotations** _(interface)_ — `interface ToolAnnotations`
  MCP tool safety hints, surfaced in `tools/list`, that tell an agent how risky a `.tool()` call is - so it can decide whether to auto-invoke or confirm first. All optional; an omitted hint means "unknown". Mirrors the MCP spec's tool `annotations`.
- **TypedSSEStream** _(interface)_ — `interface TypedSSEStream<Event>`
  The stream handed to an `app.sse()` handler: `send` takes the route's TYPED event payload and serializes it (JSON) into the SSE `data:` field — the compile-time half of the `sse` contract.
- **VERSION** _(const)_ — `VERSION: "1.13.0"`
  Current package version. A hardcoded literal on purpose — core runs on the edge (no fs), so it can't read its own package.json at runtime. `scripts/version.ts` rewrites it on every release bump and `check:publish` asserts it equals `@nifrajs/core`'s package version.
- **ValidationOutcome** _(type)_ — `type ValidationOutcome<Output> = | { readonly ok: true; readonly value: Output } | { readonly ok: false; readonly issues: ReadonlyArray<StandardIssue> }`
- **Version** _(type)_ — `type Version = typeof VERSION`
- **WebSocketContext** _(interface)_ — `interface WebSocketContext<Env = unknown>`
  The request-context subset the `upgrade()` guard sees — the same lazy accessors a route handler's `c` has (cookies/headers/env are read straight off the upgrade request). Structurally a slice of the core `RawContext`, so the real context object satisfies it.
- **WebSocketData** _(type)_ — `type WebSocketData = string | Uint8Array`
  A received frame, normalized across runtimes: text → `string`, binary → `Uint8Array`.
- **WebSocketHandler** _(interface)_ — `interface WebSocketHandler<Data = unknown, Env = unknown, Schema extends StandardSchemaV1 | undefined = undefined, Send extends StandardSchemaV1 | undefined = undefined>`
  A WebSocket route's lifecycle. All callbacks optional; only `message` is needed for an echo.
- **WebSocketUpgradeOutcome** _(type)_ — `type WebSocketUpgradeOutcome`
  The outcome of `app.resolveWebSocketUpgrade(req)` — for serving adapters: - `pass` — not a WS upgrade for a registered WS route; handle as a normal HTTP request. - `reject` — a WS route matched but `upgrade()` rejected (or the path was malformed); return `response`. - `upgrade` — perform the runtim…
- **commonSecretPatterns** _(const)_ — `commonSecretPatterns: readonly RegExp[]`
  A conservative, high-signal set of patterns for {@link RedactOptions.valuePatterns} — opt in by passing it (or a subset) to `jsonLogger`/`redactLogFields`. Covers bearer tokens, JWTs, emails, and a few well-known key formats (Stripe, GitHub, AWS access-key ids). Chosen to minimize false positives; …
- **defineIdentityPlugin** _(function)_ — `defineIdentityPlugin: (name: string, apply: <S extends AnyServer>(app: S) => S) => IdentityPlugin`
  Define a type-**identity** plugin: it registers routes/hooks as a side effect but returns the app with its `Registry` + `Context` UNCHANGED. Use this (not {@link definePlugin}) for any plugin that doesn't add context types - e.g. one mounting an auth handler. It threads the caller's *concrete* serv…
- **definePlugin** _(function)_ — `definePlugin: <In extends AnyServer, Out extends AnyServer>(name: string, apply: (app: In) => Out) => NifraPlugin<In, Out>`
  Name + ergonomics for a plugin that **adds typed context** (`derive`/`decorate`). `app.use(myPlugin)` applies it once; a second `use` of the same name is skipped (idempotent), so plugins can depend on each other without double-registering hooks.
- **defineRouterPlugin** _(const)_ — `defineRouterPlugin: (name: string, apply: <S extends AnyServer>(app: S) => S) => IdentityPlugin`
  Alias of {@link defineIdentityPlugin} with a name that says what it's FOR: a plugin that **mounts routes/hooks but adds no context type** (an auth router, an audit logger). Use this - not {@link definePlugin} - for any such plugin, or the typed client silently collapses to `any`. The "identity" in …
- **jsonLogger** _(function)_ — `jsonLogger: (write?: (line: string) => void, options?: RedactOptions) => Logger`
  The default logger: one redacted JSON object per line. `write` is injectable for tests or alternative sinks (defaults to stderr). `options` tunes redaction — pass `valuePatterns` (e.g. {@link commonSecretPatterns}) to also scrub secrets embedded in values + the message. Framework keys (`level`, `me…
- **parseCookies** _(function)_ — `parseCookies: (header: string | null | undefined) => Record<string, string>`
  Parse a request `Cookie` header into a name→value map (values URL-decoded). Unparseable pairs are skipped rather than throwing — a junk `Cookie` header shouldn't fail the request.
- **redactLogFields** _(function)_ — `redactLogFields: (fields: LogFields, options?: RedactOptions) => LogFields`
  Deep-copy `fields`, replacing values under sensitive keys with the placeholder; cycle-safe. With `options.valuePatterns`, also scans string values for those patterns (opt-in). Without options, this is pure key-name redaction (the long-standing default).
- **serializeCookie** _(function)_ — `serializeCookie: (name: string, value: string, options?: CookieOptions) => string`
  Serialize a `Set-Cookie` header value. Pure — applies **no** security defaults (the caller, e.g. `c.set.cookie`, layers `HttpOnly`/`Secure`/`SameSite` on). Throws on an invalid cookie name, a header-injecting `Path`/`Domain`, a non-integer `maxAge`, or an oversized result — a serialization bug shou…
- **server** _(function)_ — `server: <Env = unknown>(options?: ServerOptions) => Server<EmptyRegistry, { readonly env: Env; }>`
  Create a new {@link Server}. Pass an `Env` to type the platform bindings — `server<Env>()` makes `c.env: Env` in every handler + middleware, and types the `env` argument of `app.fetch` / `toFetchHandler`. Omit it and `c.env` is `unknown` (validate/cast before use).
- **signValue** _(function)_ — `signValue: (value: string, secret: string) => Promise<string>`
  Append an HMAC-SHA256 signature to a value → `value.signature` (base64url). For signed cookies.
- **silentLogger** _(const)_ — `silentLogger: Logger`
  Discards everything — for tests, or when log output is handled elsewhere.
- **toFetchHandler** _(function)_ — `toFetchHandler: <Env = unknown>(app: { fetch(request: Request, platform?: Platform<Env>): MaybePromise<Response>; resolveWebSocketUpgrade?(request: Request, platform?: Platform<Env>): MaybePromise<WebSocketUpgradeOutcom…`
- **unsignValue** _(function)_ — `unsignValue: (signed: string, secret: string) => Promise<string | null>`
  Verify a `value.signature` produced by {@link signValue} and return the value, or `null` if the signature is missing, malformed, or doesn't match. Verification is **constant-time** (`crypto.subtle.verify`), so a wrong signature can't be discovered byte-by-byte via timing.

### `@nifrajs/core/assurance`

- **AssuranceConfig** _(interface)_ — `interface AssuranceConfig`
- **AssuranceDeclaration** _(interface)_ — `interface AssuranceDeclaration`
  Metadata installed on a middleware/plugin by {@link withRouteAssurance}.
- **AssuranceEvidence** _(interface)_ — `interface AssuranceEvidence`
  Reflection-safe proof that a named enforcement module covered a route.
- **AssuranceFinding** _(interface)_ — `interface AssuranceFinding`
- **AssuranceFindingCode** _(type)_ — `type AssuranceFindingCode = | "no-routes" | "unclassified-route" | "missing-evidence" | "forbidden-evidence" | "classified-no-evidence"`
- **AssurancePolicy** _(interface)_ — `interface AssurancePolicy`
- **AssuranceReport** _(interface)_ — `interface AssuranceReport`
- **AssuranceRouteSelector** _(interface)_ — `interface AssuranceRouteSelector`
- **AssuranceRule** _(interface)_ — `interface AssuranceRule`
- **AssuranceScope** _(type)_ — `type AssuranceScope = "global" | "subsequent" | "plugin"`
  Where enforcement evidence follows Nifra's route-registration semantics.
- **AssuredRoute** _(interface)_ — `interface AssuredRoute`
- **InvariantExecutor** _(type)_ — `type InvariantExecutor = (request: Request) => Response | Promise<Response>`
  Isolated request executor used by adversarial contract verification.
- **NIFRA_ASSURANCE** _(const)_ — `NIFRA_ASSURANCE: Readonly<{ readonly AUTHENTICATED: "nifra.authenticated"; readonly BODY_BOUNDED: "nifra.body-bounded"; readonly CSRF: "nifra.csrf"; readonly DURABLE_COMMAND: "nifra.durable-command"; readonly IDEMPOTENC…`
  Canonical evidence ids emitted by Nifra's official middleware modules.
- **defineAssuranceConfig** _(function)_ — `defineAssuranceConfig: (config: AssuranceConfig) => AssuranceConfig`
  Identity helper for a `nifra.assurance.ts` default export.
- **defineAssurancePolicy** _(function)_ — `defineAssurancePolicy: (policy: AssurancePolicy) => AssurancePolicy`
  Validate and freeze an ordered assurance policy.
- **evaluateRouteAssurance** _(function)_ — `evaluateRouteAssurance: (source: unknown, policyInput: AssurancePolicy) => AssuranceReport`
  Evaluate reflected route evidence against the first matching policy rule.
- **matchesAssuranceSelector** _(function)_ — `matchesAssuranceSelector: (route: Pick<ReflectedRoute, "method" | "path" | "tool">, selector: AssuranceRouteSelector) => boolean`
  Shared selector semantics for policy rules and framework adapters.
- **withRouteAssurance** _(function)_ — `withRouteAssurance: <T extends object>(target: T, declaration: AssuranceDeclaration | readonly AssuranceDeclaration[]) => T`
  Attach enforcement evidence to the middleware/plugin that installs it.

### `@nifrajs/core/budget`

- **BudgetClock** _(interface)_ — `interface BudgetClock`
  The only clocks deadline mechanics need. Inject both for deterministic tests.
- **CreateRequestBudgetOptions** _(interface)_ — `interface CreateRequestBudgetOptions`
- **DeadlineAdmission** _(type)_ — `type DeadlineAdmission`
- **DeadlineAdmissionOptions** _(interface)_ — `interface DeadlineAdmissionOptions`
- **DeadlineExceededError** _(class)_ — `class DeadlineExceededError`
- **DeadlineHeaderResult** _(type)_ — `type DeadlineHeaderResult = | { readonly ok: true; readonly deadline: number } | { readonly ok: false; readonly reason: "missing" | "malformed" }`
- **DeadlineHeadersInit** _(type)_ — `type DeadlineHeadersInit = | Headers | Readonly<Record<string, string>> | [string, string][] | undefined`
  DOM-lib-independent subset accepted by the Web `Headers` constructor.
- **NIFRA_DEADLINE_HEADER** _(const)_ — `NIFRA_DEADLINE_HEADER: "x-nifra-deadline"`
  Canonical wire header carrying an absolute Unix epoch deadline in milliseconds.
- **RequestBudget** _(interface)_ — `interface RequestBudget`
  A time budget shared by one request and every downstream hop it initiates.
- **UNBOUNDED_DEADLINE** _(const)_ — `UNBOUNDED_DEADLINE: number`
  Sentinel used only for an unbounded local budget. It is never written to the wire.
- **admitDeadline** _(function)_ — `admitDeadline: (headers: Headers, options?: DeadlineAdmissionOptions) => DeadlineAdmission`
  Validate and clamp an inbound absolute deadline. This is pure admission mechanics: callers supply local policy, then own the timer that drives their existing cancellation signal.
- **assertBudgetRemaining** _(function)_ — `assertBudgetRemaining: (budget: RequestBudget, requiredMs?: number) => void`
  Fail before starting work that cannot fit inside the remaining time.
- **canAttempt** _(function)_ — `canAttempt: (budget: RequestBudget, estimatedAttemptMs: number, reserveMs?: number) => boolean`
  True only when a new attempt plus a caller-owned reserve can still fit.
- **createRequestBudget** _(function)_ — `createRequestBudget: (options: CreateRequestBudgetOptions) => RequestBudget`
  Create a budget from an admitted absolute deadline. Wall time is sampled once; every subsequent `remaining()` call is monotonic. This function does not arm a timer—the owner of `signal` does.
- **createUnboundedRequestBudget** _(function)_ — `createUnboundedRequestBudget: (signal: AbortSignal) => RequestBudget`
  Create a local no-deadline view. Outbound header propagation deliberately omits it.
- **parseDeadlineHeader** _(function)_ — `parseDeadlineHeader: (headers: Headers) => DeadlineHeaderResult`
  Parse the canonical deadline header without trusting or clamping it.
- **withDeadlineHeader** _(function)_ — `withDeadlineHeader: (input: DeadlineHeadersInit, budget: RequestBudget, reserveMs?: number) => Headers`
  Add this budget's absolute deadline to an outbound request.

### `@nifrajs/core/capabilities`

- **AssuredCapabilityRoute** _(interface)_ — `interface AssuredCapabilityRoute`
- **CapabilityAccess** _(type)_ — `type CapabilityAccess = "read" | "write"`
- **CapabilityAssuranceReport** _(interface)_ — `interface CapabilityAssuranceReport`
- **CapabilityDefinition** _(interface)_ — `interface CapabilityDefinition`
- **CapabilityEvidence** _(interface)_ — `interface CapabilityEvidence`
  Token-only effect evidence. `source` is an adapter/module id, never request or business data.
- **CapabilityEvidenceKind** _(type)_ — `type CapabilityEvidenceKind = "static" | "runtime"`
- **CapabilityEvidenceSet** _(interface)_ — `interface CapabilityEvidenceSet`
- **CapabilityFinding** _(interface)_ — `interface CapabilityFinding`
- **CapabilityFindingCode** _(type)_ — `type CapabilityFindingCode = | "unknown-capability" | "provenance-uncovered" | "undeclared-capability-evidence" | "safe-method-domain-write" | "missing-request-idempotency" | "missing-durable-idempotency" | "forbidden-e…`
- **CapabilityIdempotency** _(type)_ — `type CapabilityIdempotency = "none" | "request" | "durable"`
- **CapabilityImportRule** _(interface)_ — `interface CapabilityImportRule`
- **CapabilityOutcomeOptions** _(interface)_ — `interface CapabilityOutcomeOptions`
- **CapabilityPolicy** _(interface)_ — `interface CapabilityPolicy`
- **CapabilityProvenancePolicy** _(interface)_ — `interface CapabilityProvenancePolicy`
- **CapabilityRouteModule** _(interface)_ — `interface CapabilityRouteModule`
- **CapabilityRouteSelector** _(interface)_ — `interface CapabilityRouteSelector`
- **CapabilitySnapshot** _(interface)_ — `interface CapabilitySnapshot`
- **CapabilitySnapshotRoute** _(interface)_ — `interface CapabilitySnapshotRoute`
- **CapabilityUseEvent** _(interface)_ — `interface CapabilityUseEvent`
- **CapabilityZone** _(type)_ — `type CapabilityZone = "domain" | "operational"`
- **ForbiddenCapabilityImport** _(interface)_ — `interface ForbiddenCapabilityImport`
- **RouteCapabilityEvidence** _(interface)_ — `interface RouteCapabilityEvidence`
- **UseCapabilityOptions** _(interface)_ — `interface UseCapabilityOptions`
  Optional effect-ledger fields for one `useCapability` beacon. Token-only by design: an adapter names *what* it touched and *how much resource* it used — never the value it read or wrote.
- **declaredCapabilities** _(function)_ — `declaredCapabilities: (context: object) => readonly string[]`
  Read the route's token-only declaration for admission plugins. This intentionally exposes neither the request nor runtime evidence; it is the stable public seam for private entitlement policy.
- **defineCapabilityPolicy** _(function)_ — `defineCapabilityPolicy: (policy: CapabilityPolicy) => CapabilityPolicy`
  Validate and freeze a capability/provenance policy.
- **evaluateCapabilityAssurance** _(function)_ — `evaluateCapabilityAssurance: (source: unknown, policyInput: CapabilityPolicy, evidenceSet: CapabilityEvidenceSet) => CapabilityAssuranceReport`
  Compare declared route capabilities against coverage-qualified static/runtime evidence.
- **recordCapabilityOutcome** _(function)_ — `recordCapabilityOutcome: (context: object, capability: string, options: CapabilityOutcomeOptions) => void`
  Record the terminal outcome of an already-admitted capability without debiting admission twice.
- **snapshotCapabilities** _(function)_ — `snapshotCapabilities: (report: CapabilityAssuranceReport) => CapabilitySnapshot`
  Deterministic, PII-free lockfile material.
- **useCapability** _(function)_ — `useCapability: (context: object, capability: string, options?: UseCapabilityOptions) => void`
  Runtime effect beacon for owned adapters. It fails closed when the route omitted the capability or when no route guard is present. Static provenance is still required: code can bypass a beacon. When the server enabled the effect ledger, each beacon call also appends one token-only entry.
- **validCapabilityId** _(function)_ — `validCapabilityId: (value: string) => boolean`

### `@nifrajs/core/causality`

- **CAUSALITY_EXECUTION_HEADER** _(const)_ — `CAUSALITY_EXECUTION_HEADER: "x-nifra-execution-id"`
- **CAUSALITY_KIND_HEADER** _(const)_ — `CAUSALITY_KIND_HEADER: "x-nifra-causality-kind"`
- **CAUSALITY_NODE_HEADER** _(const)_ — `CAUSALITY_NODE_HEADER: "x-nifra-causality-id"`
- **CAUSALITY_TRACE_HEADER** _(const)_ — `CAUSALITY_TRACE_HEADER: "x-nifra-causality-trace"`
- **CausalityCapacityError** _(class)_ — `class CausalityCapacityError`
- **CausalityConflictError** _(class)_ — `class CausalityConflictError`
- **CausalityContext** _(interface)_ — `interface CausalityContext`
  The propagation shape carried across commands/events/jobs.
- **CausalityGraphStore** _(type)_ — `type CausalityGraphStore<Tx = unknown> = CausalityRecorder<Tx> & CausalityReader`
- **CausalityKind** _(type)_ — `type CausalityKind = string`
  A node category such as `request`, `command`, `event`, `workflow`, `projection`, or `repair`.
- **CausalityParent** _(interface)_ — `interface CausalityParent`
  One immediate parent edge. Relation is a bounded token (`caused`, `emitted`, `projected`, …).
- **CausalityParseResult** _(type)_ — `type CausalityParseResult = | { readonly success: true; readonly context: CausalityContext } | { readonly success: false readonly reason: "missing" | "incomplete" | "invalid" | "unknown-field" }`
- **CausalityReader** _(interface)_ — `interface CausalityReader`
- **CausalityRecord** _(interface)_ — `interface CausalityRecord`
  One append-only graph record. It intentionally has no payload or metadata field.
- **CausalityRecordParseResult** _(type)_ — `type CausalityRecordParseResult = | { readonly success: true; readonly record: CausalityRecord } | { readonly success: false readonly reason: "incomplete" | "invalid" | "unknown-field" }`
- **CausalityRecorder** _(interface)_ — `interface CausalityRecorder<Tx = unknown>`
- **CausalityRef** _(interface)_ — `interface CausalityRef`
  A bounded identity within one execution graph.
- **CausalityStep** _(interface)_ — `interface CausalityStep`
  A propagation context plus the graph record a durable adapter should append.
- **CausalityTimelineItem** _(interface)_ — `interface CausalityTimelineItem`
- **CausalityTimelinePage** _(interface)_ — `interface CausalityTimelinePage`
- **CausalityTrace** _(interface)_ — `interface CausalityTrace`
  Optional OpenTelemetry anchor for the nearest observed ancestor.
- **ContinueCausalityOptions** _(interface)_ — `interface ContinueCausalityOptions`
- **MemoryCausalityStoreOptions** _(interface)_ — `interface MemoryCausalityStoreOptions`
- **StartCausalityOptions** _(interface)_ — `interface StartCausalityOptions`
- **causalityHeaders** _(function)_ — `causalityHeaders: (context: CausalityContext) => Readonly<Record<string, string>>`
  Serialize the propagation context into bounded HTTP headers.
- **continueCausality** _(function)_ — `continueCausality: (parent: CausalityContext, nodeKind: CausalityKind, id: string, options?: ContinueCausalityOptions) => CausalityStep`
  Continue one execution from a single immediate parent.
- **createMemoryCausalityStore** _(function)_ — `createMemoryCausalityStore: (options?: MemoryCausalityStoreOptions) => CausalityGraphStore`
  Bounded dev/test graph store. Production callers should provide a durable adapter.
- **joinCausality** _(function)_ — `joinCausality: (parents: readonly CausalityContext[], nodeKind: CausalityKind, id: string, options?: ContinueCausalityOptions) => CausalityStep`
  Join several immediate parents. Cross-execution joins fail closed.
- **parseCausalityContext** _(function)_ — `parseCausalityContext: (input: unknown) => CausalityParseResult`
  Parse an untrusted JSON causality context. Unknown fields fail closed so payloads cannot hitchhike.
- **parseCausalityRecord** _(function)_ — `parseCausalityRecord: (input: unknown) => CausalityRecordParseResult`
  Parse an untrusted durable graph record. Unknown fields fail closed at every nesting level.
- **readCausalityHeaders** _(function)_ — `readCausalityHeaders: (headers: Headers) => CausalityParseResult`
  Parse the public header convention without ever throwing on hostile input.
- **startCausality** _(function)_ — `startCausality: (nodeKind: CausalityKind, id: string, options: StartCausalityOptions) => CausalityStep`
  Start a root execution node at an ingress boundary.

### `@nifrajs/core/classification`

- **ClassifiedSchema** _(type)_ — `type ClassifiedSchema<S extends object> = S & { readonly [CLASSIFICATION]: DataClassification }`
- **DATA_CLASSIFICATION_RANK** _(const)_ — `DATA_CLASSIFICATION_RANK: Readonly<Record<DataClassification, number>>`
  Total order over classifications; higher = more sensitive.
- **DataClassification** _(type)_ — `type DataClassification = "public" | "pii" | "secret"`
  Sensitivity of the data a response carries. Ordered `public` < `pii` < `secret`.
- **ResponseClassification** _(interface)_ — `interface ResponseClassification`
  Field paths use JSON Pointer segments; array items use a `*` segment.
- **classificationAtLeast** _(function)_ — `classificationAtLeast: (value: DataClassification, floor: DataClassification) => boolean`
  True when `value` is at least as sensitive as `floor` (e.g. `classificationAtLeast(x, "pii")`).
- **classified** _(function)_ — `classified: <S extends object>(schema: S, classification: DataClassification) => ClassifiedSchema<S>`
  Attach data-classification metadata without changing validation or inferred input/output types. For Nifra/TypeBox carriers the raw JSON Schema node is tagged too, so metadata survives composition through `t.object`, `t.array`, `t.optional`, and unions.
- **isDataClassification** _(function)_ — `isDataClassification: (value: unknown) => value is DataClassification`
  Whether `value` is a known classification token.
- **maxClassification** _(function)_ — `maxClassification: (values: Iterable<DataClassification>) => DataClassification`
  The most sensitive classification among the inputs; `"public"` when none are given.
- **reflectClassification** _(function)_ — `reflectClassification: (schema: unknown) => ResponseClassification | undefined`
  Read field-level metadata from an introspectable response schema. Never invokes its validator.
- **routeClassification** _(function)_ — `routeClassification: (responseSchema: unknown, fallback: DataClassification | undefined) => ResponseClassification | undefined`
  Merge field metadata with an optional route-level sensitivity fallback.

### `@nifrajs/core/contract`

- **ContextForOp** _(type)_ — `type ContextForOp<O extends OperationDef> = Context<O["path"], SchemaForOp<O> & RouteSchema>`
  The handler context for an op — identical to the inline `Context<Path, S>`, so a handler written for an inline route type-checks unchanged under `implement` (the graduation guarantee).
- **ContractShape** _(type)_ — `type ContractShape = Record<string, OperationDef>`
  A contract: named operations. Names are the handler keys and OpenAPI operationIds.
- **HandlersFor** _(type)_ — `type HandlersFor<C extends ContractShape, Ctx = NonNullable<unknown>> = { [K in keyof C]: (context: ContextForOp<C[K]> & Ctx) => MaybePromise<HandlerReturnForOp<C[K]>> }`
  The handlers `implement` requires: one per operation, typed from the op's input + response contract, intersected with the host app's accumulated `derive`/`decorate` context - the same `Context & Ctx` an inline {@link Handler} receives, so a handler graduates either way unchanged.
- **OperationDef** _(interface)_ — `interface OperationDef`
  One operation in a contract. Input schemas are any Standard Schema; `response` is optional.
- **RegistryFor** _(type)_ — `type RegistryFor<C extends ContractShape> = { [P in C[keyof C]["path"]]: { [K in keyof C as C[K]["path"] extends P ? C[K]["method"] : never]: RouteInfoForOp<C[K]> } }`
  Re-key the name-keyed ops into the `path → method → RouteInfo` registry.
- **RegistryFromImpl** _(type)_ — `type RegistryFromImpl<C extends ContractShape, H extends HandlersFor<C, Ctx>, Ctx = NonNullable<unknown>>`
  The registry produced by `implement`: input from the contract op; `output` is the declared `response` contract when present (it wins — exactly as in the inline path), else the bound HANDLER's return — so the implemented server stays route-for-route identical to the equivalent inline server (the mod…
- **ResponseDef** _(interface)_ — `interface ResponseDef`
  An additional (non-success) response a contract operation can document, e.g. a `404`.
- **defineContract** _(function)_ — `defineContract: <const C extends ContractShape>(contract: C) => C`
  Define a standalone, versionable contract. Identity at runtime (it returns the contract for type inference via the `const` type parameter, which preserves the path/method literals) plus boot-time (L2) validation: each operation must use a known method, a path starting with `/`, and no two operation…
- **implement** _(function)_ — `implement: <const C extends ContractShape, H extends HandlersFor<C, Ctx>, R extends Registry = {}, Ctx = {}>(contract: C, handlers: H, app?: Server<R, Ctx>) => Server<R & RegistryFromImpl<C, H, Ctx>, Ctx>`
  Bind handlers to a contract, producing a real {@link Server} you can `.listen()` or `.fetch()`. Each op is registered through the same path as the inline builder, so the result is identical to writing the routes inline — handlers lift over **unchanged** ("graduation"), and body/query schemas valida…

### `@nifrajs/core/cookies`

- **CookieOptions** _(interface)_ — `interface CookieOptions`
  Attributes for a `Set-Cookie`. `expires` is a `Date`; `maxAge` is in **seconds**.
- **parseCookies** _(function)_ — `parseCookies: (header: string | null | undefined) => Record<string, string>`
  Parse a request `Cookie` header into a name→value map (values URL-decoded). Unparseable pairs are skipped rather than throwing — a junk `Cookie` header shouldn't fail the request.
- **serializeCookie** _(function)_ — `serializeCookie: (name: string, value: string, options?: CookieOptions) => string`
  Serialize a `Set-Cookie` header value. Pure — applies **no** security defaults (the caller, e.g. `c.set.cookie`, layers `HttpOnly`/`Secure`/`SameSite` on). Throws on an invalid cookie name, a header-injecting `Path`/`Domain`, a non-integer `maxAge`, or an oversized result — a serialization bug shou…
- **signValue** _(function)_ — `signValue: (value: string, secret: string) => Promise<string>`
  Append an HMAC-SHA256 signature to a value → `value.signature` (base64url). For signed cookies.
- **unsignValue** _(function)_ — `unsignValue: (signed: string, secret: string) => Promise<string | null>`
  Verify a `value.signature` produced by {@link signValue} and return the value, or `null` if the signature is missing, malformed, or doesn't match. Verification is **constant-time** (`crypto.subtle.verify`), so a wrong signature can't be discovered byte-by-byte via timing.

### `@nifrajs/core/diff`

- **DiffSeverity** _(type)_ — `type DiffSeverity = "breaking" | "compatible" | "info"`
- **RouteChange** _(interface)_ — `interface RouteChange`
- **RouteSnapshot** _(interface)_ — `interface RouteSnapshot`
  One route in a snapshot — plain JSON, safe to persist as a CI baseline.
- **RouteSnapshotSchema** _(interface)_ — `interface RouteSnapshotSchema`
- **RoutesDiff** _(interface)_ — `interface RoutesDiff`
- **SchemaSnapshot** _(interface)_ — `interface SchemaSnapshot`
  One schema position in a snapshot: JSON Schema metadata only, no validator.
- **diffRouteSnapshots** _(function)_ — `diffRouteSnapshots: (before: readonly RouteSnapshot[], after: readonly RouteSnapshot[]) => RoutesDiff`
  Diff two route snapshots (`snapshotRoutes` output, possibly restored from JSON). Every change is classified breaking/compatible/info; `hasBreaking` is the CI-gate bit.
- **snapshotRoutes** _(function)_ — `snapshotRoutes: (source: unknown) => readonly RouteSnapshot[]`
  Snapshot an app's routes (anything `reflectRoutes` accepts) as plain JSON. Validators are dropped; only introspectable JSON Schema metadata is kept, so the result round-trips through `JSON.stringify` unchanged.

### `@nifrajs/core/effect-ledger`

- **EffectLedgerOptions** _(interface)_ — `interface EffectLedgerOptions`
  Server-level effect ledger configuration (see `server({ effectLedger })`).
- **effectLedger** _(function)_ — `effectLedger: (options: EffectLedgerOptions) => IdentityPlugin`
  Enable the per-request effect ledger. Each route that declares `schema.capabilities` gets a bounded, token-only ledger; `useCapability(c, id, …)` appends one entry per effect, and the sink receives the sealed ledger when the response settles (only when it recorded entries). Token-only by constructi…

### `@nifrajs/core/idempotency`

- **DEFAULT_IDEMPOTENCY_HEADER** _(const)_ — `DEFAULT_IDEMPOTENCY_HEADER: "idempotency-key"`
  Canonical request header carrying the client-chosen idempotency key.
- **DEFAULT_IDEMPOTENCY_TTL_MS** _(const)_ — `DEFAULT_IDEMPOTENCY_TTL_MS: 86400000`
  Default retention for a stored idempotent response: 24 hours.
- **IDEMPOTENT_REPLAY_HEADER** _(const)_ — `IDEMPOTENT_REPLAY_HEADER: "x-nifra-idempotent-replay"`
  Header stamped on a replayed response so clients/proxies can tell a replay from a fresh run.
- **IdempotencyAbandonInput** _(interface)_ — `interface IdempotencyAbandonInput`
- **IdempotencyBeginInput** _(interface)_ — `interface IdempotencyBeginInput`
- **IdempotencyBeginResult** _(type)_ — `type IdempotencyBeginResult`
  Outcome of reserving a key. `new` → the caller runs the handler and later calls {@link * IdempotencyStore.complete}. `replay` → return the stored response, handler never runs. `mismatch` → same key, different request fingerprint (client bug) → 409. `in-flight` → the key is reserved but not yet comp…
- **IdempotencyCompletionInput** _(interface)_ — `interface IdempotencyCompletionInput`
- **IdempotencyEntryKey** _(interface)_ — `interface IdempotencyEntryKey`
  Namespaces isolate the same client key across tenants/subjects without putting identity in a header.
- **IdempotencyResponseTooLargeError** _(class)_ — `class IdempotencyResponseTooLargeError`
- **IdempotencyScope** _(type)_ — `type IdempotencyScope = "request" | "durable"`
  Whether a route's idempotency is satisfied by an in-process store or a durable (cross-restart) one.
- **IdempotencyStore** _(interface)_ — `interface IdempotencyStore`
  Storage seam for idempotent responses. `begin` MUST be atomic: for one key, exactly one concurrent caller sees `new`; the rest see `in-flight` (or `replay` once completed). The in-memory store gets this free from the single-threaded event loop; a durable store uses an atomic insert.
- **MemoryIdempotencyStore** _(class)_ — `class MemoryIdempotencyStore`
  In-process idempotency store. Reservation is atomic by construction — `begin` never awaits, so the single-threaded event loop serializes concurrent callers for one key. Expired entries are treated as absent (lazy eviction on access); a periodic {@link MemoryIdempotencyStore.sweep} bounds memory.
- **MemoryIdempotencyStoreOptions** _(interface)_ — `interface MemoryIdempotencyStoreOptions`
- **StoredResponse** _(interface)_ — `interface StoredResponse`
  A serialized response held by a store. `body` is base64 so binary payloads round-trip intact.
- **canonicalizeIdempotencyBody** _(function)_ — `canonicalizeIdempotencyBody: (body: Uint8Array, contentType: string | null) => Uint8Array`
  Canonicalize JSON bodies so whitespace/property-order retries bind to the same semantic request.
- **computeIdempotencyFingerprint** _(function)_ — `computeIdempotencyFingerprint: (method: string, path: string, body: Uint8Array, contentType?: string) => Promise<string>`
  SHA-256 fingerprint binding a key to one request: method, path (+ query), and the raw body bytes. A collision-resistant hash matters — a weak hash would let a crafted body replay another's response.
- **createMemoryIdempotencyStore** _(function)_ — `createMemoryIdempotencyStore: (options?: MemoryIdempotencyStoreOptions) => MemoryIdempotencyStore`
  Convenience factory mirroring the other core primitives' `create*` style.
- **responseFromStored** _(function)_ — `responseFromStored: (stored: StoredResponse, options?: { readonly maxBytes?: number; }) => Response`
  Rebuild a live response from storage, stamping the replay marker header.
- **serializeResponse** _(function)_ — `serializeResponse: (response: Response, options?: { readonly maxBytes?: number; }) => Promise<StoredResponse>`
  Buffer a response into a storable form. Clones first so the live response body stays intact.
- **validIdempotencyKey** _(function)_ — `validIdempotencyKey: (key: string) => boolean`
  A key must be a non-empty, bounded, control-char-free token. Fail closed on anything else.
- **validIdempotencyNamespace** _(function)_ — `validIdempotencyNamespace: (namespace: string) => boolean`
  Namespace values are server-resolved, bounded opaque tokens (normally a tenant/subject hash).

### `@nifrajs/core/idempotency-plugin`

- **IdempotencyPluginOptions** _(interface)_ — `interface IdempotencyPluginOptions`
  Enable request idempotency. Routes that declare `schema.idempotency` get the dedupe lane: a repeat `Idempotency-Key` replays the stored response instead of re-running the handler. Without this plugin, declaring `schema.idempotency` is a registration error (the safety gate can never be silently drop…
- **idempotency** _(function)_ — `idempotency: (options?: IdempotencyPluginOptions) => IdentityPlugin`

### `@nifrajs/core/ledger`

- **CreateRequestLedgerOptions** _(interface)_ — `interface CreateRequestLedgerOptions`
- **DEFAULT_MAX_ENTRIES** _(const)_ — `DEFAULT_MAX_ENTRIES: 1000`
  Per-request entry bound. Generous for real handlers, small enough to stop a runaway loop.
- **EffectChain** _(interface)_ — `interface EffectChain`
  Tamper-evidence over the route identity, declarations, and sealed entries.
- **EffectCost** _(type)_ — `type EffectCost = Readonly<Record<string, number>>`
  Dimensionless resource counters (`{ ms: 12, calls: 1, bytes: 512 }`). Counters carry *how much resource* an effect consumed; mapping counters to money/pricing is deliberately out of scope here.
- **EffectEntry** _(interface)_ — `interface EffectEntry`
  One recorded effect. Frozen; token-only by construction (no payload field exists).
- **EffectEntryInput** _(interface)_ — `interface EffectEntryInput`
  Caller-supplied fields for one entry. Everything else (`seq`, `at`) is assigned by the ledger.
- **EffectLedgerOptions** _(interface)_ — `interface EffectLedgerOptions`
  Server-level effect ledger configuration (see `server({ effectLedger })`).
- **EffectLedgerOverflowError** _(class)_ — `class EffectLedgerOverflowError`
  Thrown by `append` when the per-request entry bound is exceeded. Fails the request closed.
- **EffectLedgerSealedError** _(class)_ — `class EffectLedgerSealedError`
  Thrown by `append` after `seal()` — e.g. an effect attempted while streaming a response body.
- **EffectPhase** _(type)_ — `type EffectPhase = "intent" | "committed" | "failed" | "compensated"`
  Lifecycle phase of one effect. `intent` precedes execution; the rest describe its outcome.
- **LedgerSink** _(type)_ — `type LedgerSink = (ledger: SealedEffectLedger) => void | Promise<void>`
  Receives each sealed ledger once per request (only when it has entries). Implementations must not assume a payload: the ledger is token-only. A durable/tenant-scoped sink lives behind this seam.
- **MAX_COST_AXES** _(const)_ — `MAX_COST_AXES: 8`
  Most cost axes one entry may carry.
- **MIN_DIGEST_KEY_BYTES** _(const)_ — `MIN_DIGEST_KEY_BYTES: 16`
  Minimum digest key material. A short key would make the keyed digest brute-forceable.
- **MemoryLedgerSink** _(interface)_ — `interface MemoryLedgerSink`
- **MemoryLedgerSinkOptions** _(interface)_ — `interface MemoryLedgerSinkOptions`
- **RequestLedger** _(interface)_ — `interface RequestLedger`
  Per-request ledger. `append` is synchronous (hot-path safe); `seal` is idempotent and async.
- **SealedEffectLedger** _(interface)_ — `interface SealedEffectLedger`
  The immutable result of sealing a request's ledger. Token-only; safe to hand to any sink.
- **attachEffectLedger** _(function)_ — `attachEffectLedger: (context: object, ledger: RequestLedger) => void`
  Framework wiring: attach a per-request ledger to a handler context. Not for application code.
- **computeEffectDigest** _(function)_ — `computeEffectDigest: (key: Uint8Array | CryptoKey, payload: Uint8Array) => Promise<string>`
  Keyed HMAC-SHA-256 digest (hex) of an effect payload, for replay/reconciliation matching without storing the payload. Keyed on purpose: a bare hash of low-entropy data (an email, a flag) is brute-forceable and would itself leak. Digest the **whole** effect payload, never a single field.
- **createMemoryLedgerSink** _(function)_ — `createMemoryLedgerSink: (options?: MemoryLedgerSinkOptions) => MemoryLedgerSink`
  Bounded in-memory sink for tests and local development. Token-only, like every sink.
- **createRequestLedger** _(function)_ — `createRequestLedger: (options: CreateRequestLedgerOptions) => RequestLedger`
  Create a bounded per-request ledger. The server wires one per capability-declaring route.
- **effectLedgerOf** _(function)_ — `effectLedgerOf: (context: object) => RequestLedger | undefined`
  The request's effect ledger, when the server enabled one for this route. Read-only access.
- **randomEffectDigestKey** _(function)_ — `randomEffectDigestKey: () => Uint8Array`
  Fresh random digest key (32 bytes). Per-process by default — persist one externally to correlate across restarts.

### `@nifrajs/core/logger`

- **LogFields** _(type)_ — `type LogFields = Record<string, unknown>`
  Structured, redacting logger. The framework logs through this interface so secrets/PII are scrubbed once, centrally (per the project's logging rule), not at each call site. Bring your own by passing `logger` to `server()`.
- **Logger** _(interface)_ — `interface Logger`
- **RedactOptions** _(interface)_ — `interface RedactOptions`
  Tunes redaction. Key-name redaction always runs; the rest is **opt-in**: - `keyParts` — extra case-insensitive key fragments, added to the built-in denylist. - `valuePatterns` — regexes matched against string **values** *and* the log message; each match is replaced with the placeholder. This is the…
- **commonSecretPatterns** _(const)_ — `commonSecretPatterns: readonly RegExp[]`
  A conservative, high-signal set of patterns for {@link RedactOptions.valuePatterns} — opt in by passing it (or a subset) to `jsonLogger`/`redactLogFields`. Covers bearer tokens, JWTs, emails, and a few well-known key formats (Stripe, GitHub, AWS access-key ids). Chosen to minimize false positives; …
- **jsonLogger** _(function)_ — `jsonLogger: (write?: (line: string) => void, options?: RedactOptions) => Logger`
  The default logger: one redacted JSON object per line. `write` is injectable for tests or alternative sinks (defaults to stderr). `options` tunes redaction — pass `valuePatterns` (e.g. {@link commonSecretPatterns}) to also scrub secrets embedded in values + the message. Framework keys (`level`, `me…
- **redactLogFields** _(function)_ — `redactLogFields: (fields: LogFields, options?: RedactOptions) => LogFields`
  Deep-copy `fields`, replacing values under sensitive keys with the placeholder; cycle-safe. With `options.valuePatterns`, also scans string values for those patterns (opt-in). Without options, this is pure key-name redaction (the long-standing default).
- **silentLogger** _(const)_ — `silentLogger: Logger`
  Discards everything — for tests, or when log output is handled elsewhere.

### `@nifrajs/core/manifest`

- **BuildNifraManifestInput** _(interface)_ — `interface BuildNifraManifestInput`
- **NifraManifest** _(interface)_ — `interface NifraManifest`
- **NifraManifestAssurance** _(interface)_ — `interface NifraManifestAssurance`
- **NifraManifestCapabilities** _(interface)_ — `interface NifraManifestCapabilities`
- **NifraManifestChange** _(interface)_ — `interface NifraManifestChange`
- **NifraManifestDiff** _(interface)_ — `interface NifraManifestDiff`
- **NifraManifestRoute** _(interface)_ — `interface NifraManifestRoute`
- **NifraManifestSignature** _(interface)_ — `interface NifraManifestSignature`
- **NifraManifestSigner** _(interface)_ — `interface NifraManifestSigner`
- **buildNifraManifest** _(function)_ — `buildNifraManifest: (input: BuildNifraManifestInput) => Promise<NifraManifest>`
  Build one fail-closed, deterministic manifest from already-evaluated assurance reports.
- **canonicalManifest** _(function)_ — `canonicalManifest: (manifest: Pick<NifraManifest, "manifestVersion" | "routes">) => string`
  Canonical bytes are stable across runtime, object-key order, and route registration order.
- **diffNifraManifests** _(function)_ — `diffNifraManifests: (before: NifraManifest, after: NifraManifest) => NifraManifestDiff`
  Contract changes reuse the route-diff engine; governance changes fail closed on expanded risk.
- **parseNifraManifest** _(function)_ — `parseNifraManifest: (content: string, source?: string) => Promise<NifraManifest>`
  Parse and hash-verify an emitted manifest before it is trusted by diff/codegen tooling.
- **parseNifraManifestSignature** _(function)_ — `parseNifraManifestSignature: (content: string, source?: string) => NifraManifestSignature`
  Parse the detached sidecar before selecting its operator-controlled public key.
- **serializeNifraManifest** _(function)_ — `serializeNifraManifest: (manifest: NifraManifest) => string`
  Byte-stable artifact serialization (including `contentHash`).
- **serializeNifraManifestSignature** _(function)_ — `serializeNifraManifestSignature: (signature: NifraManifestSignature) => string`
  Byte-stable serialization for the detached signature sidecar.
- **signNifraManifest** _(function)_ — `signNifraManifest: (manifest: NifraManifest, signer: NifraManifestSigner) => Promise<NifraManifestSignature>`
  Sign without handling private keys: the operator-supplied signer may call KMS/HSM/local WebCrypto.
- **verifyNifraManifestSignature** _(function)_ — `verifyNifraManifestSignature: (manifest: NifraManifest, signature: NifraManifestSignature, publicKey: CryptoKey) => Promise<boolean>`
  Verify the hash first, then the detached Ed25519 signature. Malformed/tampered input returns false.

### `@nifrajs/core/mcp`

- **mcp** _(function)_ — `mcp: () => IdentityPlugin`
  Enable MCP declarations on a server: `.use(mcp())` turns on `.tool()`, `.resource()`, and `.prompt()`. Applying it twice is a no-op (named plugin dedupe).

### `@nifrajs/core/mount`

- **BackendMount** _(interface)_ — `interface BackendMount<Env = unknown>`
  Structural mount capability exposed by an in-process typed client.
- **BackendMountHandler** _(type)_ — `type BackendMountHandler<Env = unknown> = ( request: Request, platform?: Platform<Env>, ) => Response | Promise<Response>`
  Dispatch one already-materialized request into a backend with its outer runtime platform context.
- **NIFRA_BACKEND_MOUNT** _(const)_ — `NIFRA_BACKEND_MOUNT: typeof NIFRA_BACKEND_MOUNT`
  Global symbol so independently bundled copies of core/client/web still agree on the mount seam.

### `@nifrajs/core/node-direct`

- **NodeServeOutcome** _(type)_ — `type NodeServeOutcome`
  What {@link Server.resolveNode} returns: either a plain-data render the `@nifrajs/node` adapter writes to the socket directly (`kind: "json"` - status + headers + cookies + a pre-stringified body, **no** undici `Response` built or drained), a marked buffered response body (`kind: "body"` - e.g.
- **nodeDirect** _(function)_ — `nodeDirect: () => IdentityPlugin`
  Enable `app.resolveNode()` for direct callers. Applying it twice is a no-op (named plugin dedupe).

### `@nifrajs/core/pattern`

- **CompiledRoutePattern** _(interface)_ — `interface CompiledRoutePattern`
  Compiled route grammar shared by runtime routers, browser navigation, mocks, and adapters.
- **RoutePatternMatch** _(type)_ — `type RoutePatternMatch = | { readonly matched: true; readonly params: Record<string, string> } | { readonly matched: false; readonly reason: "not-found" | "malformed" }`
- **RoutePatternSegment** _(type)_ — `type RoutePatternSegment = | { readonly kind: "static"; readonly value: string } | { readonly kind: "param"; readonly name: string } | { readonly kind: "wildcard"; readonly name: string }`
- **compareRoutePatternSpecificity** _(function)_ — `compareRoutePatternSpecificity: (left: CompiledRoutePattern, right: CompiledRoutePattern) => number`
  Core precedence: static > param > wildcard at the first differing segment, independent of order.
- **compileRoutePattern** _(function)_ — `compileRoutePattern: (pattern: string) => CompiledRoutePattern`
  Parse and validate Nifra's strict route grammar once. Trailing slashes remain significant.
- **decodeRouteParams** _(function)_ — `decodeRouteParams: (raw: Record<string, string>) => Record<string, string> | null`
  Decode router captures under one rule. Plain values take the zero-allocation path; malformed escapes return `null`, allowing HTTP to emit 400 while client navigation declines the match.
- **matchRoutePattern** _(function)_ — `matchRoutePattern: (compiled: CompiledRoutePattern, pathname: string) => RoutePatternMatch`
  Match one compiled pattern and return decoded captures. The caller decides cross-pattern order.

### `@nifrajs/core/reflection`

- **JsonSchema** _(type)_ — `type JsonSchema = boolean | Readonly<Record<string, unknown>>`
  JSON Schema permits either a schema object or the boolean schemas `true` and `false`.
- **ReflectedRoute** _(interface)_ — `interface ReflectedRoute`
- **ReflectedRouteSchema** _(interface)_ — `interface ReflectedRouteSchema`
- **ReflectedSchemaField** _(interface)_ — `interface ReflectedSchemaField`
  One top-level property of an introspectable object schema.
- **SchemaReflection** _(interface)_ — `interface SchemaReflection`
  Validation and introspection capabilities discovered for one schema-like value.
- **reflectRoutes** _(function)_ — `reflectRoutes: (source: unknown) => readonly ReflectedRoute[]`
  Safely enumerate and normalize route descriptors from an app or descriptor array. Invalid entries are ignored; a missing/throwing `routes()` method yields an empty array.
- **reflectSchema** _(function)_ — `reflectSchema: (value: unknown) => SchemaReflection`
  Reflect a Standard Schema, Nifra/TypeBox schema carrier, or raw JSON Schema. Never throws. Validation-only schemas have `standard` but no `jsonSchema`; raw JSON Schema has the reverse.

### `@nifrajs/core/router`

- **EMPTY_PARAMS** _(const)_ — `EMPTY_PARAMS: Record<string, string>`
- **METHODS** _(const)_ — `METHODS: readonly ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]`
  HTTP methods the router accepts.
- **Method** _(type)_ — `type Method = (typeof METHODS)[number]`
- **Router** _(class)_ — `class Router<T>`
  Radix-style segment trie router. Matching precedence is static > param > wildcard. Parameter/wildcard values are returned RAW (not percent-decoded); the server boundary decodes and rejects malformed encodings with a 400, keeping this layer pure and allocation-light.
- **RouterMatch** _(type)_ — `type RouterMatch<T>`
  Result of {@link Router.find}. The `found: false` cases deliberately separate a missing path (404) from a path that exists for other methods (405), so the server layer can answer correctly and populate an `Allow` header.

### `@nifrajs/core/schema`

- **InferInput** _(type)_ — `type InferInput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["input"]`
- **InferOutput** _(type)_ — `type InferOutput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["output"]`
- **StandardFailure** _(interface)_ — `interface StandardFailure`
- **StandardIssue** _(interface)_ — `interface StandardIssue`
- **StandardPathSegment** _(interface)_ — `interface StandardPathSegment`
- **StandardResult** _(type)_ — `type StandardResult<Output> = StandardSuccess<Output> | StandardFailure`
- **StandardSchemaProps** _(interface)_ — `interface StandardSchemaProps<Input = unknown, Output = Input>`
- **StandardSchemaV1** _(interface)_ — `interface StandardSchemaV1<Input = unknown, Output = Input>`
  The Standard Schema v1 interface (https://standardschema.dev), vendored as types + a tiny runtime helper so any compliant validator — zod, valibot, arktype, … — validates requests without coupling the framework to one lib. The spec is MIT-licensed and explicitly designed to be copied.
- **StandardSuccess** _(interface)_ — `interface StandardSuccess<Output>`
- **StandardTypes** _(interface)_ — `interface StandardTypes<Input = unknown, Output = Input>`
- **ValidationOutcome** _(type)_ — `type ValidationOutcome<Output> = | { readonly ok: true; readonly value: Output } | { readonly ok: false; readonly issues: ReadonlyArray<StandardIssue> }`
- **validateStandard** _(function)_ — `validateStandard: <Schema extends StandardSchemaV1>(schema: Schema, value: unknown) => ValidationOutcome<InferOutput<Schema>> | Promise<ValidationOutcome<InferOutput<Schema>>>`
  Run a Standard Schema and normalize the result. Sync validators stay sync; async validators are awaited.

### `@nifrajs/core/seo`

- **RobotsOptions** _(interface)_ — `interface RobotsOptions`
- **RobotsRule** _(interface)_ — `interface RobotsRule`
- **SitemapChangeFreq** _(type)_ — `type SitemapChangeFreq = | "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never"`
- **SitemapEntry** _(interface)_ — `interface SitemapEntry`
- **SitemapOptions** _(interface)_ — `interface SitemapOptions`
- **robots** _(function)_ — `robots: (options: RobotsOptions) => string`
  Build a `robots.txt` body from grouped rules plus optional `Sitemap:`/`Host:` lines.
- **sitemap** _(function)_ — `sitemap: (entries: readonly SitemapEntry[], options?: SitemapOptions) => string`
  Build a `<urlset>` sitemap XML document from `entries`. Throws on out-of-spec input (dev-time data).

### `@nifrajs/core/server`

- **AdmissionController** _(interface)_ — `interface AdmissionController`
  A capacity-admission gate. Decides, per request, whether the instance has capacity to run it now - bounding *concurrency*, which rate limits (frequency) and deadlines (duration) do not. Provide an implementation (see `@nifrajs/middleware`'s `createAdmissionController`) as {@link ServerOptions.admis…
- **AdmissionDecision** _(type)_ — `type AdmissionDecision = | { readonly admitted: true; release(): void } | { readonly admitted: false; readonly response: Response }`
  The outcome of a capacity-admission decision. `admitted` requests carry a `release` the server calls exactly once when the response is finalized; a shed request carries a ready `429` Response.
- **AnyServer** _(type)_ — `type AnyServer = Server<any, any>`
- **Context** _(interface)_ — `interface Context<Path extends string = string, S extends RouteSchema = RouteSchema>`
  Handler context. `params` are inferred from the path; `body` and `query` are the validated outputs of their schemas when declared (else `undefined` / raw `URLSearchParams`).
- **CookieOptions** _(interface)_ — `interface CookieOptions`
  Attributes for a `Set-Cookie`. `expires` is a `Date`; `maxAge` is in **seconds**.
- **DurableObjectNamespaceLike** _(interface)_ — `interface DurableObjectNamespaceLike`
  Structural view of a Cloudflare Durable Object namespace binding — keeps `@cloudflare/workers-types` out of `@nifrajs/core`. The real `DurableObjectNamespace` satisfies it.
- **ExecutionContext** _(interface)_ — `interface ExecutionContext`
  A Cloudflare Workers-style execution context (the `fetch` 3rd arg). Structural — only `waitUntil` is used; declared here so `@nifrajs/core` needs no Workers type dependency.
- **FRAMEWORK_NAME** _(const)_ — `FRAMEWORK_NAME: "Nifra"`
  Single source of truth for the framework's user-facing name.
- **FrameworkError** _(class)_ — `class FrameworkError`
  Base class for every error the framework throws. Carries a stable, string `code` so callers can branch on the failure programmatically rather than matching on message text. Messages are prefixed with the brand name.
- **FrameworkName** _(type)_ — `type FrameworkName = typeof FRAMEWORK_NAME`
- **Handler** _(type)_ — `type Handler<Path extends string, S extends RouteSchema = RouteSchema, Ctx = EmptyContext> = (ctx: Context<Path, S> & Ctx) => MaybePromise<ResponseOf<S>>`
  Public handler shape: context typed from the path, the (optional) schema, and any accumulated middleware context `Ctx` (from `derive`/`decorate`).
- **IdentityPlugin** _(type)_ — `type IdentityPlugin = (<S extends AnyServer>(app: S) => S) & { readonly pluginName?: string }`
  A named type-identity plugin built with {@link defineIdentityPlugin}. It returns the same concrete server type it receives, preserving the caller's typed registry and context across `.use()` while still allowing the plugin to register runtime hooks or handlers.
- **InferInput** _(type)_ — `type InferInput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["input"]`
- **InferOutput** _(type)_ — `type InferOutput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["output"]`
- **LogFields** _(type)_ — `type LogFields = Record<string, unknown>`
  Structured, redacting logger. The framework logs through this interface so secrets/PII are scrubbed once, centrally (per the project's logging rule), not at each call site. Bring your own by passing `logger` to `server()`.
- **Logger** _(interface)_ — `interface Logger`
- **METHODS** _(const)_ — `METHODS: readonly ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]`
  HTTP methods the router accepts.
- **McpPromptDescriptor** _(interface)_ — `interface McpPromptDescriptor`
  An app-declared MCP prompt - a reusable prompt template an agent can fetch through `nifra mcp`.
- **McpResourceDescriptor** _(interface)_ — `interface McpResourceDescriptor`
  An app-declared MCP resource - read-only data an agent can fetch through `nifra mcp`.
- **Method** _(type)_ — `type Method = (typeof METHODS)[number]`
- **Middleware** _(interface)_ — `interface Middleware`
  A bundle of lifecycle hooks applied together via {@link Server.use} - the unit `@nifrajs/middleware` ships (cors, security headers, rate-limit). Every hook is optional and wired to its lifecycle point. Middleware is context-agnostic (sees the base `Context`); `use` does no context-type merging - th…
- **NifraPlugin** _(type)_ — `type NifraPlugin<In extends AnyServer = AnyServer, Out extends AnyServer = In> = (( app: In, ) => Out) & { readonly pluginName?: string }`
  A nifra **plugin**: a function that augments an app - calling `use`/`derive`/`decorate` and/or registering routes - and returns it. Because `derive`/`decorate` are type-threaded, an **inline** `app.use((a) => a.derive(...).decorate(...))` carries the added context to handlers defined after it (the …
- **NifraWebSocket** _(interface)_ — `interface NifraWebSocket<Data = unknown>`
  The portable socket handed to WS lifecycle callbacks. Each adapter wraps its native socket.
- **NodeServeOutcome** _(type)_ — `type NodeServeOutcome`
  What {@link Server.resolveNode} returns: either a plain-data render the `@nifrajs/node` adapter writes to the socket directly (`kind: "json"` - status + headers + cookies + a pre-stringified body, **no** undici `Response` built or drained), a marked buffered response body (`kind: "body"` - e.g.
- **OnRequestResult** _(type)_ — `type OnRequestResult = Response | Request | undefined`
- **Params** _(type)_ — `type Params<Path extends string> = Prettify<RawParams<Path>>`
- **Platform** _(interface)_ — `interface Platform<Env = unknown>`
  Runtime platform inputs, passed as `app.fetch(request, platform)`. Edge adapters (e.g. Cloudflare Workers) supply `env` (bindings) + `waitUntil`; Bun/Node/Deno omit them. Optional + runtime-neutral, so `app.fetch` stays a Web-standard handler.
- **Prettify** _(type)_ — `type Prettify<T> = { [K in keyof T]: T[K] } & {}`
  Flattens an intersection into a single object type for readable hovers.
- **PromptArgument** _(interface)_ — `interface PromptArgument`
  One declared argument of an MCP prompt, surfaced in `prompts/list`.
- **PromptMessage** _(interface)_ — `interface PromptMessage`
  A message in an MCP prompt's rendered output (see {@link Server.prompt}).
- **RedactOptions** _(interface)_ — `interface RedactOptions`
  Tunes redaction. Key-name redaction always runs; the rest is **opt-in**: - `keyParts` — extra case-insensitive key fragments, added to the built-in denylist. - `valuePatterns` — regexes matched against string **values** *and* the log message; each match is replaced with the placeholder. This is the…
- **Registry** _(type)_ — `type Registry = Record<string, Record<string, RouteInfo>>`
  The accumulated, type-level map of every route on a Server: path → method → RouteInfo.
- **ResponseControls** _(interface)_ — `interface ResponseControls`
  Mutable response controls a handler may write to before returning.
- **ResponseFinalization** _(interface)_ — `interface ResponseFinalization`
  The terminal response-pipeline outcome observed after every transforming `onResponse` hook.
- **RouteConfigError** _(class)_ — `class RouteConfigError`
  Thrown at route registration when a route is misconfigured. This is the boot-time rejection layer: loud and early, never deferred to the first request.
- **RouteConfigErrorCode** _(type)_ — `type RouteConfigErrorCode = | "DUPLICATE_ROUTE" | "DUPLICATE_PARAM" | "PARAM_NAME_CONFLICT" | "INVALID_PATH" | "INVALID_PARAM_NAME" | "WILDCARD_NOT_LAST" | "INVALID_METHOD" | "INVALID_ASSURANCE" | "INVALID_IDEMPOTENCY"`
  Stable codes for boot-time (L2) route configuration failures.
- **RouteDescriptor** _(interface)_ — `interface RouteDescriptor`
  A registered route's public descriptor - method, path, and input schemas. The router trie discards the original patterns, so this flat list is what lets tools (e.g. `toOpenAPI`) enumerate routes after registration.
- **RouteInfo** _(interface)_ — `interface RouteInfo`
  One route's input/output shape as the **client** will consume it. `query`/`body` are `never` when the route declares no schema for them, so the client can detect "this route takes no body" via `[body] extends [never]`. `output` is the handler's raw return type (the client applies `Jsonify` when rea…
- **RouteSchema** _(interface)_ — `interface RouteSchema`
  Per-route input schemas. Each is any Standard Schema (zod/valibot/arktype/…).
- **Router** _(class)_ — `class Router<T>`
  Radix-style segment trie router. Matching precedence is static > param > wildcard. Parameter/wildcard values are returned RAW (not percent-decoded); the server boundary decodes and rejects malformed encodings with a 400, keeping this layer pure and allocation-light.
- **RouterMatch** _(type)_ — `type RouterMatch<T>`
  Result of {@link Router.find}. The `found: false` cases deliberately separate a missing path (404) from a path that exists for other methods (405), so the server layer can answer correctly and populate an `Allow` header.
- **RunningServer** _(interface)_ — `interface RunningServer`
  The handle `listen()` returns - the slice of Bun's server nifra holds and exposes. Declared explicitly (rather than `ReturnType<typeof Bun.serve>`) so the public type surface doesn't leak the ambient `Bun` global into consumers' `.d.ts` resolution.
- **SSEContext** _(interface)_ — `interface SSEContext`
  Minimal context shape `sse` needs — the live request, for its client-disconnect signal.
- **SSEInit** _(interface)_ — `interface SSEInit`
- **SSEMessage** _(interface)_ — `interface SSEMessage`
  One SSE frame. Every field is optional; `data` may be multi-line (emitted as multiple `data:` lines).
- **SSEStream** _(interface)_ — `interface SSEStream`
  The stream handed to the `run` callback.
- **ScheduledController** _(interface)_ — `interface ScheduledController`
  A Cloudflare Workers-style scheduled (cron) controller. Structural — no Workers type dependency.
- **ScheduledHandler** _(type)_ — `type ScheduledHandler<Env = unknown> = ( controller: ScheduledController, context: { readonly env: Env; waitUntil(promise: Promise<unknown>): void }, ) => MaybePromise<void>`
  A nifra cron handler: the platform controller + the same typed `env`/`waitUntil` nifra threads into request handlers. Schedule background work with `waitUntil` so it outlives the trigger.
- **Server** _(class)_ — `class Server<R extends Registry = EmptyRegistry, Ctx = EmptyContext>`
  The inline server. Routes are chainable and fully type-inferred. `derive`/ `decorate` extend the handler context (`Ctx`) for routes defined *after* them, with full types; `Ctx` is server-only and never touches the client registry.
- **ServerOptions** _(interface)_ — `interface ServerOptions`
- **StandardIssue** _(interface)_ — `interface StandardIssue`
- **StandardResult** _(type)_ — `type StandardResult<Output> = StandardSuccess<Output> | StandardFailure`
- **StandardSchemaV1** _(interface)_ — `interface StandardSchemaV1<Input = unknown, Output = Input>`
  The Standard Schema v1 interface (https://standardschema.dev), vendored as types + a tiny runtime helper so any compliant validator — zod, valibot, arktype, … — validates requests without coupling the framework to one lib. The spec is MIT-licensed and explicitly designed to be copied.
- **StandardTypes** _(interface)_ — `interface StandardTypes<Input = unknown, Output = Input>`
- **StandardWebSocket** _(interface)_ — `interface StandardWebSocket`
  A standard server-side `WebSocket` — the half returned by Deno's `Deno.upgradeWebSocket` and the Workers `WebSocketPair`. {@link attachWebSocket} wires one to a nifra handler, so the Deno and Workers bridges share all the dispatch/normalization/error-isolation logic (only the upgrade call differs).
- **ToolAnnotations** _(interface)_ — `interface ToolAnnotations`
  MCP tool safety hints, surfaced in `tools/list`, that tell an agent how risky a `.tool()` call is - so it can decide whether to auto-invoke or confirm first. All optional; an omitted hint means "unknown". Mirrors the MCP spec's tool `annotations`.
- **TypedSSEStream** _(interface)_ — `interface TypedSSEStream<Event>`
  The stream handed to an `app.sse()` handler: `send` takes the route's TYPED event payload and serializes it (JSON) into the SSE `data:` field — the compile-time half of the `sse` contract.
- **ValidationOutcome** _(type)_ — `type ValidationOutcome<Output> = | { readonly ok: true; readonly value: Output } | { readonly ok: false; readonly issues: ReadonlyArray<StandardIssue> }`
- **WebSocketContext** _(interface)_ — `interface WebSocketContext<Env = unknown>`
  The request-context subset the `upgrade()` guard sees — the same lazy accessors a route handler's `c` has (cookies/headers/env are read straight off the upgrade request). Structurally a slice of the core `RawContext`, so the real context object satisfies it.
- **WebSocketData** _(type)_ — `type WebSocketData = string | Uint8Array`
  A received frame, normalized across runtimes: text → `string`, binary → `Uint8Array`.
- **WebSocketHandler** _(interface)_ — `interface WebSocketHandler<Data = unknown, Env = unknown, Schema extends StandardSchemaV1 | undefined = undefined, Send extends StandardSchemaV1 | undefined = undefined>`
  A WebSocket route's lifecycle. All callbacks optional; only `message` is needed for an echo.
- **WebSocketUpgradeOutcome** _(type)_ — `type WebSocketUpgradeOutcome`
  The outcome of `app.resolveWebSocketUpgrade(req)` — for serving adapters: - `pass` — not a WS upgrade for a registered WS route; handle as a normal HTTP request. - `reject` — a WS route matched but `upgrade()` rejected (or the path was malformed); return `response`. - `upgrade` — perform the runtim…
- **commonSecretPatterns** _(const)_ — `commonSecretPatterns: readonly RegExp[]`
  A conservative, high-signal set of patterns for {@link RedactOptions.valuePatterns} — opt in by passing it (or a subset) to `jsonLogger`/`redactLogFields`. Covers bearer tokens, JWTs, emails, and a few well-known key formats (Stripe, GitHub, AWS access-key ids). Chosen to minimize false positives; …
- **defineIdentityPlugin** _(function)_ — `defineIdentityPlugin: (name: string, apply: <S extends AnyServer>(app: S) => S) => IdentityPlugin`
  Define a type-**identity** plugin: it registers routes/hooks as a side effect but returns the app with its `Registry` + `Context` UNCHANGED. Use this (not {@link definePlugin}) for any plugin that doesn't add context types - e.g. one mounting an auth handler. It threads the caller's *concrete* serv…
- **definePlugin** _(function)_ — `definePlugin: <In extends AnyServer, Out extends AnyServer>(name: string, apply: (app: In) => Out) => NifraPlugin<In, Out>`
  Name + ergonomics for a plugin that **adds typed context** (`derive`/`decorate`). `app.use(myPlugin)` applies it once; a second `use` of the same name is skipped (idempotent), so plugins can depend on each other without double-registering hooks.
- **defineRouterPlugin** _(const)_ — `defineRouterPlugin: (name: string, apply: <S extends AnyServer>(app: S) => S) => IdentityPlugin`
  Alias of {@link defineIdentityPlugin} with a name that says what it's FOR: a plugin that **mounts routes/hooks but adds no context type** (an auth router, an audit logger). Use this - not {@link definePlugin} - for any such plugin, or the typed client silently collapses to `any`. The "identity" in …
- **jsonLogger** _(function)_ — `jsonLogger: (write?: (line: string) => void, options?: RedactOptions) => Logger`
  The default logger: one redacted JSON object per line. `write` is injectable for tests or alternative sinks (defaults to stderr). `options` tunes redaction — pass `valuePatterns` (e.g. {@link commonSecretPatterns}) to also scrub secrets embedded in values + the message. Framework keys (`level`, `me…
- **parseCookies** _(function)_ — `parseCookies: (header: string | null | undefined) => Record<string, string>`
  Parse a request `Cookie` header into a name→value map (values URL-decoded). Unparseable pairs are skipped rather than throwing — a junk `Cookie` header shouldn't fail the request.
- **redactLogFields** _(function)_ — `redactLogFields: (fields: LogFields, options?: RedactOptions) => LogFields`
  Deep-copy `fields`, replacing values under sensitive keys with the placeholder; cycle-safe. With `options.valuePatterns`, also scans string values for those patterns (opt-in). Without options, this is pure key-name redaction (the long-standing default).
- **serializeCookie** _(function)_ — `serializeCookie: (name: string, value: string, options?: CookieOptions) => string`
  Serialize a `Set-Cookie` header value. Pure — applies **no** security defaults (the caller, e.g. `c.set.cookie`, layers `HttpOnly`/`Secure`/`SameSite` on). Throws on an invalid cookie name, a header-injecting `Path`/`Domain`, a non-integer `maxAge`, or an oversized result — a serialization bug shou…
- **server** _(function)_ — `server: <Env = unknown>(options?: ServerOptions) => Server<EmptyRegistry, { readonly env: Env; }>`
  Create a new {@link Server}. Pass an `Env` to type the platform bindings — `server<Env>()` makes `c.env: Env` in every handler + middleware, and types the `env` argument of `app.fetch` / `toFetchHandler`. Omit it and `c.env` is `unknown` (validate/cast before use).
- **signValue** _(function)_ — `signValue: (value: string, secret: string) => Promise<string>`
  Append an HMAC-SHA256 signature to a value → `value.signature` (base64url). For signed cookies.
- **silentLogger** _(const)_ — `silentLogger: Logger`
  Discards everything — for tests, or when log output is handled elsewhere.
- **toFetchHandler** _(function)_ — `toFetchHandler: <Env = unknown>(app: { fetch(request: Request, platform?: Platform<Env>): MaybePromise<Response>; resolveWebSocketUpgrade?(request: Request, platform?: Platform<Env>): MaybePromise<WebSocketUpgradeOutcom…`
- **unsignValue** _(function)_ — `unsignValue: (signed: string, secret: string) => Promise<string | null>`
  Verify a `value.signature` produced by {@link signValue} and return the value, or `null` if the signature is missing, malformed, or doesn't match. Verification is **constant-time** (`crypto.subtle.verify`), so a wrong signature can't be discovered byte-by-byte via timing.

### `@nifrajs/core/sse`

- **SSEContext** _(interface)_ — `interface SSEContext`
  Minimal context shape `sse` needs — the live request, for its client-disconnect signal.
- **SSEInit** _(interface)_ — `interface SSEInit`
- **SSEMessage** _(interface)_ — `interface SSEMessage`
  One SSE frame. Every field is optional; `data` may be multi-line (emitted as multiple `data:` lines).
- **SSEStream** _(interface)_ — `interface SSEStream`
  The stream handed to the `run` callback.
- **TypedSSEStream** _(interface)_ — `interface TypedSSEStream<Event>`
  The stream handed to an `app.sse()` handler: `send` takes the route's TYPED event payload and serializes it (JSON) into the SSE `data:` field — the compile-time half of the `sse` contract.
- **sse** _(function)_ — `sse: (c: SSEContext, run: (stream: SSEStream) => void | Promise<void>, init?: SSEInit) => Response`
- **streaming** _(function)_ — `streaming: () => IdentityPlugin`
  Enable `.sse()` streaming routes: `.use(streaming())` installs the SSE runtime. Without it, an `.sse()` route is a registration error, so the ReadableStream framing stays out of non-SSE bundles. The `sse()` / `typedSSEStream()` helpers ship from this same subpath for use inside handlers.
- **typedSSEStream** _(function)_ — `typedSSEStream: <Event>(stream: SSEStream) => TypedSSEStream<Event>`
  Wrap a raw {@link SSEStream} in the typed, JSON-serializing surface `app.sse()` hands out.

### `@nifrajs/core/webhook`

- **SignatureEncoding** _(type)_ — `type SignatureEncoding = "hex" | "base64"`
- **VerifyWebhookOptions** _(interface)_ — `interface VerifyWebhookOptions`
- **WebhookFailureReason** _(type)_ — `type WebhookFailureReason = | "missing_signature" | "invalid_signature" | "timestamp_out_of_tolerance" | "malformed_signature" | "payload_too_large" | "invalid_content_length"`
- **WebhookProvider** _(type)_ — `type WebhookProvider = "stripe" | "github" | "generic"`
- **WebhookResult** _(type)_ — `type WebhookResult = | { readonly ok: true; readonly payload: string } | { readonly ok: false; readonly reason: WebhookFailureReason }`
  Verified ⇒ the raw `payload` text (parse it with your schema). Rejected ⇒ a stable `reason`.
- **verifyWebhook** _(function)_ — `verifyWebhook: (req: Request, secret: string | readonly string[], options?: VerifyWebhookOptions) => Promise<WebhookResult>`
  Verify a webhook request's signature and return its raw payload. Reads `req.body` (bounded), so the body is consumed — parse the returned `payload`, don't re-read the request.

### `@nifrajs/core/ws`

- **NifraWebSocket** _(interface)_ — `interface NifraWebSocket<Data = unknown>`
  The portable socket handed to WS lifecycle callbacks. Each adapter wraps its native socket.
- **StandardWebSocket** _(interface)_ — `interface StandardWebSocket`
  A standard server-side `WebSocket` — the half returned by Deno's `Deno.upgradeWebSocket` and the Workers `WebSocketPair`. {@link attachWebSocket} wires one to a nifra handler, so the Deno and Workers bridges share all the dispatch/normalization/error-isolation logic (only the upgrade call differs).
- **TopicRegistry** _(class)_ — `class TopicRegistry`
  In-process pub/sub for `ws.subscribe(topic)` + `app.publish(topic, data)`. **Single-instance only** — topics live in this process's memory, so a multi-instance deploy (multiple servers behind a load balancer) needs an external fan-out (Redis pub/sub, a Cloudflare Durable Object, NATS, …) bridged to…
- **WebSocketContext** _(interface)_ — `interface WebSocketContext<Env = unknown>`
  The request-context subset the `upgrade()` guard sees — the same lazy accessors a route handler's `c` has (cookies/headers/env are read straight off the upgrade request). Structurally a slice of the core `RawContext`, so the real context object satisfies it.
- **WebSocketData** _(type)_ — `type WebSocketData = string | Uint8Array`
  A received frame, normalized across runtimes: text → `string`, binary → `Uint8Array`.
- **WebSocketHandler** _(interface)_ — `interface WebSocketHandler<Data = unknown, Env = unknown, Schema extends StandardSchemaV1 | undefined = undefined, Send extends StandardSchemaV1 | undefined = undefined>`
  A WebSocket route's lifecycle. All callbacks optional; only `message` is needed for an echo.
- **WebSocketUpgradeOutcome** _(type)_ — `type WebSocketUpgradeOutcome`
  The outcome of `app.resolveWebSocketUpgrade(req)` — for serving adapters: - `pass` — not a WS upgrade for a registered WS route; handle as a normal HTTP request. - `reject` — a WS route matched but `upgrade()` rejected (or the path was malformed); return `response`. - `upgrade` — perform the runtim…
- **attachWebSocket** _(function)_ — `attachWebSocket: (socket: StandardWebSocket, handler: WebSocketHandler, data: unknown, options: { openNow: boolean; pubsub: TopicRegistry; }) => NifraWebSocket`
  Wire a standard server-side `WebSocket` to a nifra {@link WebSocketHandler}, returning the portable {@link NifraWebSocket}. Shared by the Deno and Workers bridges. `openNow` fires `open` immediately (Workers, where the socket is already open after `accept()`); otherwise `open` waits for the socket'…
- **websocket** _(function)_ — `websocket: () => IdentityPlugin`
  Enable WebSocket routes on a server: `.use(websocket())` turns on `app.ws()`. Applying it twice is a no-op (named plugin dedupe).
- **wrapWebSocketMessageValidation** _(function)_ — `wrapWebSocketMessageValidation: (handler: WebSocketHandler) => WebSocketHandler`
  If the handler declares a `messageSchema`, return a copy whose `message` validates each frame — parse as JSON, run the Standard Schema, then call the user's `message` with the typed value, or `onInvalidMessage` on failure. Returns the handler unchanged when no schema is set. Called once at `app.ws(…

## @nifrajs/cron

- **CronError** _(class)_ — `class CronError`
  Thrown on a malformed cron expression — loud at registration, never at fire time.
- **CronFields** _(interface)_ — `interface CronFields`
  A parsed expression: one allowed-values Set per field, + whether dom/dow were restricted (for the standard OR rule).
- **CronHandler** _(type)_ — `type CronHandler = () => void | Promise<void>`
- **Scheduler** _(interface)_ — `interface Scheduler`
- **SchedulerOptions** _(interface)_ — `interface SchedulerOptions`
- **createScheduler** _(function)_ — `createScheduler: (options?: SchedulerOptions) => Scheduler`
  Create an in-process cron scheduler.
- **matches** _(function)_ — `matches: (fields: CronFields, date: Date) => boolean`
  Does `date` (in its LOCAL time — cron is local-time by convention) match the fields, to the minute? Day-of-month and day-of-week follow the standard OR rule: when BOTH are restricted, a match on EITHER is a match; when only one is restricted, only that one must match.
- **nextRun** _(function)_ — `nextRun: (fields: CronFields, from: Date) => Date | null`
  The next instant at/after `from` (exclusive of the current minute's already-started second) that matches. Steps minute-by-minute with a safety cap (~5 years) so a never-matching expression returns `null` instead of looping forever.
- **parseCron** _(function)_ — `parseCron: (expression: string) => CronFields`
  Parse a 5-field cron expression (or a `@macro`) into matchable {@link CronFields}.

## @nifrajs/deno

- **DenoServer** _(interface)_ — `interface DenoServer`
- **FetchHandler** _(interface)_ — `interface FetchHandler`
  Anything exposing a Web `fetch` handler — a nifra `app`, for instance.
- **ServeOptions** _(interface)_ — `interface ServeOptions`
- **serve** _(function)_ — `serve: (app: FetchHandler, options: ServeOptions) => Promise<DenoServer>`
  Serve a Web-`fetch` app on Deno. Returns once bound, so `port` is the real one (matters for `port: 0`).

## @nifrajs/devtools

### `@nifrajs/devtools`

- **DevToolsClientOptions** _(interface)_ — `interface DevToolsClientOptions`
- **DevToolsEvent** _(interface)_ — `interface DevToolsEvent`
- **DevToolsOptions** _(interface)_ — `interface DevToolsOptions`
- **devtools** _(function)_ — `devtools: (options?: DevToolsOptions | undefined) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  DevTools plugin. Its observation adapter projects the single request span into a `DevToolsEvent`; its middleware only owns the secured SSE transport. When configuring `tracing()` yourself, register it before this plugin so DevTools attaches to that request owner.
- **devtoolsClientScript** _(function)_ — `devtoolsClientScript: (options?: DevToolsClientOptions) => string`
  Returns a self-contained JavaScript string that creates a floating DevTools overlay in the browser. Inject via `<script>` tag in dev mode.

### `@nifrajs/devtools/client`

- **devtoolsClientScript** _(function)_ — `devtoolsClientScript: (options?: DevToolsClientOptions) => string`
  Returns a self-contained JavaScript string that creates a floating DevTools overlay in the browser. Inject via `<script>` tag in dev mode.

## @nifrajs/env

- **DefineEnvOptions** _(interface)_ — `interface DefineEnvOptions`
- **EnvResult** _(type)_ — `type EnvResult<S extends EnvShape> = { readonly [K in keyof S]: InferOutput<S[K]> }`
  The frozen, validated result — each key typed by its schema's output.
- **EnvShape** _(type)_ — `type EnvShape = Record<string, StandardSchemaV1>`
  A schema per variable name.
- **InferOutput** _(type)_ — `type InferOutput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["output"]`
  Extract a Standard Schema's validated output type.
- **StandardResult** _(type)_ — `type StandardResult<Output> = | { readonly value: Output; readonly issues?: undefined } | { readonly issues: ReadonlyArray<StandardIssue> }`
- **StandardSchemaV1** _(interface)_ — `interface StandardSchemaV1<Output = unknown>`
- **boolean** _(function)_ — `boolean: (opts?: Base<boolean>) => StandardSchemaV1<boolean>`
  A boolean: `true`/`1`/`yes`/`on` → true; `false`/`0`/`no`/`off`/empty → false (case-insensitive).
- **defineEnv** _(function)_ — `defineEnv: <S extends EnvShape>(shape: S, options?: DefineEnvOptions) => EnvResult<S>`
  Validate the environment against a schema and return a **frozen, typed** object — or throw at startup listing **every** problem at once (not just the first), so a misconfigured deploy fails loud and immediately instead of erroring on the first request that touches a bad var. This is the boot-time h…
- **enumValue** _(function)_ — `enumValue: <const V extends readonly [string, ...string[]]>(values: V, opts?: Base<V[number]>) => StandardSchemaV1<V[number]>`
  One of a fixed set of string values.
- **env** _(const)_ — `env: { string: (opts?: Base<string> & Optional) => StandardSchemaV1<string | undefined>; number: (opts?: Base<number> & Optional) => StandardSchemaV1<number | undefined>; port: (opts?: Base<number>) => StandardSchemaV1<…`
  The coercing env validators, grouped — `env.string()`, `env.port()`, `env.enum([...])`, …
- **number** _(function)_ — `number: (opts?: Base<number> & Optional) => StandardSchemaV1<number | undefined>`
  A finite number, coerced from its decimal string.
- **port** _(function)_ — `port: (opts?: Base<number>) => StandardSchemaV1<number>`
  A TCP port: an integer in 1–65535.
- **string** _(function)_ — `string: (opts?: Base<string> & Optional) => StandardSchemaV1<string | undefined>`
  A required (or defaulted/optional) non-empty string.
- **url** _(function)_ — `url: (opts?: Base<string> & Optional) => StandardSchemaV1<string | undefined>`
  A valid absolute URL (parses with the WHATWG `URL`). Returns the normalized href string.

## @nifrajs/events

- **EventContract** _(interface)_ — `interface EventContract<Schema extends StandardSchemaV1 = StandardSchemaV1>`
- **EventContractError** _(class)_ — `class EventContractError`
  Thrown by {@link EventContract.create} when the payload fails the contract schema.
- **EventEnvelope** _(interface)_ — `interface EventEnvelope<Payload = unknown>`
  The portable wire shape: identity + versioned type + timestamp + validated payload.
- **EventParseResult** _(type)_ — `type EventParseResult<Payload> = | { readonly success: true; readonly envelope: EventEnvelope<Payload> } | { readonly success: false; readonly issues: readonly StandardIssue[] }`
- **EventRegistry** _(interface)_ — `interface EventRegistry`
- **RegistryParseResult** _(type)_ — `type RegistryParseResult`
- **createEventRegistry** _(function)_ — `createEventRegistry: (contracts: readonly EventContract[]) => EventRegistry`
  Build a registry from a set of contracts. Throws on a duplicate `type@version`.
- **defineEventContract** _(function)_ — `defineEventContract: <Schema extends StandardSchemaV1>(spec: { type: string; version: number; payload: Schema; }) => EventContract<Schema>`
  Define a portable, versioned event contract.

## @nifrajs/i18n

- **Formatter** _(interface)_ — `interface Formatter`
- **Locale** _(type)_ — `type Locale = string`
  Locale negotiation — pick the best supported locale for a request, from (in priority order) an explicit cookie, then the `Accept-Language` header (quality-ranked, with a base-tag fallback so `fr-CA` matches a supported `fr`). Pure + runtime-agnostic.
- **Messages** _(type)_ — `type Messages = Record<string, string>`
  A tiny ICU message formatter on the platform `Intl`. Supports interpolation (`{name}`), `plural` (`{n, plural, one {# item} other {# items}}`, with `=N` exact cases and `#` → the number), and `select` (`{kind, select, a {…} other {…}}`), nested arbitrarily. Parsed by a hand-written recursive descen…
- **NegotiateOptions** _(interface)_ — `interface NegotiateOptions`
- **createFormatter** _(function)_ — `createFormatter: (locale: string, messages: Messages) => Formatter`
  Build (or reuse) a {@link Formatter} bound to a locale + its message catalog. Cheap to call per request/render — instances are cached per `(messages, locale)`, and parsed ASTs + `Intl.*` are memoized inside each. The catalog is the app's (import a JSON file); this only negotiates (see `negotiateLoc…
- **negotiateLocale** _(function)_ — `negotiateLocale: (request: Request, options: NegotiateOptions) => Locale`
  Negotiate the request's locale. Order: a valid {@link NegotiateOptions.cookie} value → `Accept-Language` (each `q`-ranked tag, exact then base-subtag) → `defaultLocale`.

## @nifrajs/image

### `@nifrajs/image`

- **CloudflareLoaderOptions** _(interface)_ — `interface CloudflareLoaderOptions`
- **HtmlImageAttrs** _(interface)_ — `interface HtmlImageAttrs`
  Plain lowercase HTML `<img>` attributes (`srcset`/`fetchpriority`, not React's camelCase).
- **ImageFormat** _(type)_ — `type ImageFormat = "png" | "jpeg" | "gif" | "webp"`
  Read an image's intrinsic dimensions from its file **header**, in pure JS — no decode, no codec, no dependency. Supports PNG, JPEG, GIF, and WebP (VP8/VP8L/VP8X). Used to give `<Image>` CLS-safe `width`/`height` (build-time tooling can pre-read them into a manifest).
- **ImageInfo** _(interface)_ — `interface ImageInfo`
- **ImageLoader** _(type)_ — `type ImageLoader = (args: { src: string; width: number; quality?: number }) => string`
  Builds a variant URL for `src` at a target pixel `width` (and optional `quality`).
- **ImageProps** _(interface)_ — `interface ImageProps`
- **ResolvedImage** _(interface)_ — `interface ResolvedImage`
- **SelfHostedLoaderOptions** _(interface)_ — `interface SelfHostedLoaderOptions`
- **SignImageUrlOptions** _(interface)_ — `interface SignImageUrlOptions`
- **cloudflareLoader** _(function)_ — `cloudflareLoader: (options?: CloudflareLoaderOptions) => ImageLoader`
  Cloudflare Images loader — builds `/cdn-cgi/image/<options>/<source>` URLs that the Cloudflare edge resizes on the fly (also emits `format=auto` for webp/avif negotiation). Works on Cloudflare Pages / Workers with Images enabled.
- **identityLoader** _(const)_ — `identityLoader: ImageLoader`
  Default loader: return the source unchanged (no transform). Use when there's no image CDN — you still get CLS-safe sizing + lazy loading, just no responsive variants.
- **imageDimensions** _(function)_ — `imageDimensions: (bytes: Uint8Array) => ImageInfo | null`
  Parse intrinsic dimensions + format from image header bytes, or `null` if unrecognized/too short.
- **readImageDimensions** _(function)_ — `readImageDimensions: (source: { arrayBuffer(): Promise<ArrayBuffer>; stream?: () => ReadableStream<Uint8Array>; }, maxBytes?: number) => Promise<ImageInfo | null>`
  Read just the leading bytes of an image file (via the platform `Bun.file`/`fetch` blob) and parse its dimensions. Build-time tooling: pre-read dimensions into a manifest so `<Image>` is CLS-safe without hardcoding sizes. Reads at most `maxBytes` (default 64 KB — enough for any header).
- **resolveImage** _(function)_ — `resolveImage: (props: ImageProps, loader?: ImageLoader) => ResolvedImage`
  Resolve {@link ImageProps} + an {@link ImageLoader} into `<img>` attributes. CLS-safe (`width`/ `height` required + > 0, else a dev error), lazy + async-decoding by default, with a responsive `srcSet` built from `widths` via the loader. If every width produces the same URL (e.g. {@link identityLoad…
- **selfHostedLoader** _(function)_ — `selfHostedLoader: (options: SelfHostedLoaderOptions) => ImageLoader`
  Loader for nifra's **self-hosted** resize endpoint (`createImageHandler` from `@nifrajs/image/server`, backed by `Bun.Image`/sharp/WASM). Builds `<endpoint>?src=…&w=…[&q=…][&s=…]` (the endpoint negotiates the output format). Pure + dependency-free. For runtimes without a native codec, pair the endp…
- **signImageUrl** _(function)_ — `signImageUrl: (endpoint: string, image: { src: string; width: number; quality?: number; }, options: SignImageUrlOptions) => string`
  Mint a **signed** self-hosted image URL on the server — for cases the (stable) `selfHostedLoader` doesn't cover, chiefly **time-limited** access (`expiresIn`) to private images. Server-only (it holds the secret). Pair with a passthrough loader, or use the signed string as a plain `src`.
- **toHtmlAttrs** _(function)_ — `toHtmlAttrs: (resolved: ResolvedImage) => HtmlImageAttrs`
  Map a {@link ResolvedImage} to plain lowercase HTML `<img>` attribute names — `srcset` (not React's `srcSet`), `fetchpriority` (not `fetchPriority`) — dropping unset optionals. For the adapters that spread attributes straight onto a host element (Solid / Vue / Svelte / Preact); React consumes `Reso…

### `@nifrajs/image/backends`

- **CONTENT_TYPE** _(const)_ — `CONTENT_TYPE: Record<OutputFormat, string>`
- **DecodedImage** _(interface)_ — `interface DecodedImage`
  A decoded image: RGBA pixels + dimensions — the lingua franca of WASM codecs (jSquash, Photon, …).
- **ImageBackend** _(interface)_ — `interface ImageBackend`
  The codec seam. The handler owns all request-level security (validation, SSRF, byte/pixel caps, concurrency, caching); a backend only decodes/resizes/encodes. Backends MUST translate codec failures into {@link ImageProcessingError} so the handler can map them to stable HTTP statuses.
- **ImageProbe** _(interface)_ — `interface ImageProbe`
  Header-only probe of a source image: intrinsic dimensions + decoded format. Must be cheap (no full decode) — it gates the decompression-bomb and no-upscale checks before the expensive resize.
- **ImageProcessingError** _(class)_ — `class ImageProcessingError`
  Normalized, backend-agnostic processing failure. Lets the handler map codec errors to HTTP status without coupling to any one codec's error codes.
- **OutputFormat** _(type)_ — `type OutputFormat = "webp" | "jpeg" | "png"`
  Output formats nifra's endpoint can emit. AVIF is intentionally excluded — `Bun.Image` reports `ERR_IMAGE_FORMAT_UNSUPPORTED` for AVIF encode on common platforms, so offering it would 500.
- **ResizeInput** _(interface)_ — `interface ResizeInput`
- **ResizeOutput** _(interface)_ — `interface ResizeOutput`
- **SharpLike** _(type)_ — `type SharpLike = (input: Uint8Array) => SharpInstance`
  The slice of a [sharp](https://sharp.pixelplumbing.com) instance this backend uses. Declared structurally so `@nifrajs/image` has no dependency on sharp — pass your own `sharp` import.
- **WasmImageCodecs** _(interface)_ — `interface WasmImageCodecs`
  Pluggable WASM codec set — decode/resize/encode. Declared structurally so `@nifrajs/image` depends on no WASM library; wire your own (jSquash is the common pure-WASM, edge-safe choice). The handler probes dimensions from the source header (bomb-safe), so `decode` runs only inside `transform`.
- **bunImageBackend** _(function)_ — `bunImageBackend: () => ImageBackend`
  {@link ImageBackend} backed by `Bun.Image` (libjpeg-turbo / libspng / libwebp, decoded off the main thread). Requires the Bun runtime. The default backend of `createImageHandler`.
- **sharpImageBackend** _(function)_ — `sharpImageBackend: (sharp: SharpLike) => ImageBackend`
  {@link ImageBackend} backed by [sharp](https://sharp.pixelplumbing.com) (libvips) for Node servers. Pass your `sharp` import — `@nifrajs/image` never imports it, so it stays dependency-free and you control the version:
- **wasmImageBackend** _(function)_ — `wasmImageBackend: (codecs: WasmImageCodecs) => ImageBackend`
  {@link ImageBackend} backed by injected WASM codecs — the only backend that runs on the **edge** (Workers / Vercel-Edge / Deno-Deploy), where neither `Bun.Image` nor sharp exists. `probe` reads the source header via nifra's dependency-free reader (so decompression bombs are rejected before any deco…

### `@nifrajs/image/server`

- **CONTENT_TYPE** _(const)_ — `CONTENT_TYPE: Record<OutputFormat, string>`
- **DecodedImage** _(interface)_ — `interface DecodedImage`
  A decoded image: RGBA pixels + dimensions — the lingua franca of WASM codecs (jSquash, Photon, …).
- **ImageBackend** _(interface)_ — `interface ImageBackend`
  The codec seam. The handler owns all request-level security (validation, SSRF, byte/pixel caps, concurrency, caching); a backend only decodes/resizes/encodes. Backends MUST translate codec failures into {@link ImageProcessingError} so the handler can map them to stable HTTP statuses.
- **ImageHandlerOptions** _(interface)_ — `interface ImageHandlerOptions`
- **ImageProbe** _(interface)_ — `interface ImageProbe`
  Header-only probe of a source image: intrinsic dimensions + decoded format. Must be cheap (no full decode) — it gates the decompression-bomb and no-upscale checks before the expensive resize.
- **ImageProcessingError** _(class)_ — `class ImageProcessingError`
  Normalized, backend-agnostic processing failure. Lets the handler map codec errors to HTTP status without coupling to any one codec's error codes.
- **OutputFormat** _(type)_ — `type OutputFormat = "webp" | "jpeg" | "png"`
  Output formats nifra's endpoint can emit. AVIF is intentionally excluded — `Bun.Image` reports `ERR_IMAGE_FORMAT_UNSUPPORTED` for AVIF encode on common platforms, so offering it would 500.
- **ResizeInput** _(interface)_ — `interface ResizeInput`
- **ResizeOutput** _(interface)_ — `interface ResizeOutput`
- **SharpLike** _(type)_ — `type SharpLike = (input: Uint8Array) => SharpInstance`
  The slice of a [sharp](https://sharp.pixelplumbing.com) instance this backend uses. Declared structurally so `@nifrajs/image` has no dependency on sharp — pass your own `sharp` import.
- **WasmImageCodecs** _(interface)_ — `interface WasmImageCodecs`
  Pluggable WASM codec set — decode/resize/encode. Declared structurally so `@nifrajs/image` depends on no WASM library; wire your own (jSquash is the common pure-WASM, edge-safe choice). The handler probes dimensions from the source header (bomb-safe), so `decode` runs only inside `transform`.
- **bunImageBackend** _(function)_ — `bunImageBackend: () => ImageBackend`
  {@link ImageBackend} backed by `Bun.Image` (libjpeg-turbo / libspng / libwebp, decoded off the main thread). Requires the Bun runtime. The default backend of `createImageHandler`.
- **createImageHandler** _(function)_ — `createImageHandler: (options?: ImageHandlerOptions) => (req: Request) => Promise<Response>`
  Build the resize request handler. Mount its return value at the `selfHostedLoader` endpoint:
- **sharpImageBackend** _(function)_ — `sharpImageBackend: (sharp: SharpLike) => ImageBackend`
  {@link ImageBackend} backed by [sharp](https://sharp.pixelplumbing.com) (libvips) for Node servers. Pass your `sharp` import — `@nifrajs/image` never imports it, so it stays dependency-free and you control the version:
- **wasmImageBackend** _(function)_ — `wasmImageBackend: (codecs: WasmImageCodecs) => ImageBackend`
  {@link ImageBackend} backed by injected WASM codecs — the only backend that runs on the **edge** (Workers / Vercel-Edge / Deno-Deploy), where neither `Bun.Image` nor sharp exists. `probe` reads the source header via nifra's dependency-free reader (so decompression bombs are rejected before any deco…

## @nifrajs/islets

- **BindableElement** _(interface)_ — `interface BindableElement`
  The element surface the walker needs — structural, so tests can drive it without a real DOM.
- **BindableRoot** _(interface)_ — `interface BindableRoot`
- **IslandContext** _(interface)_ — `interface IslandContext`
- **IslandHost** _(interface)_ — `interface IslandHost`
  The host-element surface `mountIslands` needs beyond bindings.
- **IslandScope** _(type)_ — `type IslandScope = { readonly signals: Readonly<Record<string, Signal<unknown>>> readonly handlers: Readonly<Record<string, (event: Event) => void>> }`
- **IslandSetup** _(type)_ — `type IslandSetup = (ctx: IslandContext) => Record<string, (event: Event) => void> | undefined`
  An island's setup function: read/seed state, return the event handlers the markup names.
- **Signal** _(type)_ — `type Signal<T> = { (): T set(next: T | ((prev: T) => T)): void }`
  A readable/writable reactive value: call it to read (tracking), `.set` to write.
- **batch** _(function)_ — `batch: <T>(fn: () => T) => T`
  Batch writes: effects triggered inside `fn` run ONCE after it returns, deduplicated — so `setA(); setB()` updates the DOM once, not twice. Re-entrant; an effect re-queued during the flush runs in the same flush.
- **bindScope** _(function)_ — `bindScope: (root: BindableRoot, scope: IslandScope) => Array<() => void>`
  Walk `root` and attach every `data-bind-*` binding against `scope`. Returns the disposers of the created effects (an island unmount can stop them; page-lifetime islands just drop them).
- **computed** _(function)_ — `computed: <T>(fn: () => T) => () => T`
  Derived value, cached into a signal — recomputes when its tracked inputs change.
- **effect** _(function)_ — `effect: (fn: () => void) => () => void`
  Run `fn` now and again whenever any signal it read changes. Returns a disposer. Dependencies re-track on every run, so conditional reads subscribe to exactly the live branch.
- **island** _(function)_ — `island: (name: string, setup: IslandSetup) => void`
  Register an island's behavior by name (the markup's `data-island` value).
- **islandState** _(function)_ — `islandState: (state: Record<string, unknown>) => string`
  Server-side helper: the value for a host's `data-island-state` attribute. Plain JSON — emit it through an escaping renderer (`@nifrajs/web-vanilla`'s `html` escapes quotes in attributes), e.g. `html\`<div data-island="compare" data-island-state="${islandState({ count })}">…\``.
- **mountIslands** _(function)_ — `mountIslands: (root?: BindableRoot) => void`
  Mount every registered island under `root` (default: the document). Idempotent — a host is marked once mounted, so calling again (e.g. after a soft navigation swapped content in) only mounts new hosts. Unregistered island names are skipped silently: markup may ship ahead of its script, and progress…
- **signal** _(function)_ — `signal: <T>(initial: T) => Signal<T>`
  Create a signal. Reads inside an {@link effect} (or {@link computed}) subscribe automatically.

## @nifrajs/jobs

- **Backoff** _(type)_ — `type Backoff = (attempt: number) => number`
  ms to wait before the next attempt, given the number of attempts already made (1-based).
- **EnqueueOptions** _(interface)_ — `interface EnqueueOptions`
- **ExponentialOptions** _(interface)_ — `interface ExponentialOptions`
- **JobContext** _(interface)_ — `interface JobContext`
  What a handler receives alongside the payload: identity + which attempt this is (1-based).
- **JobCounts** _(interface)_ — `interface JobCounts`
- **JobDefinition** _(interface)_ — `interface JobDefinition<Payload>`
  A job definition registered on a queue.
- **JobError** _(class)_ — `class JobError`
  Thrown for a misuse of the queue API (duplicate/unknown job name).
- **JobHandle** _(interface)_ — `interface JobHandle<Payload>`
  A typed handle to enqueue a defined job.
- **JobHandler** _(type)_ — `type JobHandler<Payload> = (payload: Payload, ctx: JobContext) => void | Promise<void>`
  A job processor. A throw/rejection routes to `onError` and triggers retry/dead-letter — never crashes the worker.
- **JobStore** _(interface)_ — `interface JobStore`
  Persistence + leasing for the queue. The default {@link MemoryJobStore} is single-process (dev / a single long-running server); implement this over Redis/Postgres/etc. for durability or multiple workers. All methods may be sync or async — the queue awaits them.
- **JobValidationError** _(class)_ — `class JobValidationError`
  Thrown by `enqueue` when the payload fails the job's `input` schema (validation at the trust boundary).
- **MemoryJobStore** _(class)_ — `class MemoryJobStore`
  Construct an in-memory job store. `idFor` is injectable for deterministic tests.
- **Queue** _(interface)_ — `interface Queue`
- **QueueOptions** _(interface)_ — `interface QueueOptions`
- **RetryPolicy** _(interface)_ — `interface RetryPolicy`
- **StandardResult** _(type)_ — `type StandardResult<Output> = | { readonly value: Output; readonly issues?: undefined } | { readonly issues: ReadonlyArray<{ readonly message: string }> }`
  The validate-result half of the Standard Schema spec.
- **StandardSchemaV1** _(interface)_ — `interface StandardSchemaV1<Output = unknown>`
  A minimal structural view of a Standard Schema validator (v1). `t.object(...)` satisfies it.
- **StoredJob** _(interface)_ — `interface StoredJob`
  A job as handed back by {@link JobStore.lease}. `attempt` is the count of PRIOR attempts (0 the first time).
- **Worker** _(interface)_ — `interface Worker`
- **WorkerOptions** _(interface)_ — `interface WorkerOptions`
- **createQueue** _(function)_ — `createQueue: (options?: QueueOptions) => Queue`
  Create a job queue. Define jobs, enqueue payloads, and `start()` a worker (or `drain()` once).
- **exponentialBackoff** _(function)_ — `exponentialBackoff: (options?: ExponentialOptions) => Backoff`
  Exponential backoff: `baseMs * 2^(attempt-1)`, capped at `maxMs`, with optional jitter.
- **fixedBackoff** _(const)_ — `fixedBackoff: (ms: number) => Backoff`
  Fixed delay before every retry.
- **noBackoff** _(const)_ — `noBackoff: Backoff`
  No delay — retry immediately.

## @nifrajs/mcp

### `@nifrajs/mcp`

- **CreateMcpServerOptions** _(interface)_ — `interface CreateMcpServerOptions`
- **DefineMcpToolOptions** _(interface)_ — `interface DefineMcpToolOptions<S extends StandardSchemaV1 = UntypedArgs>`
- **DefineMcpWidgetOptions** _(interface)_ — `interface DefineMcpWidgetOptions`
- **InferOutput** _(type)_ — `type InferOutput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["output"]`
  The validated (post-transform) type of a Standard Schema.
- **JsonRpcNotification** _(interface)_ — `interface JsonRpcNotification`
- **JsonRpcRequest** _(interface)_ — `interface JsonRpcRequest`
- **JsonRpcResponse** _(type)_ — `type JsonRpcResponse = | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown } | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } }`
- **McpAppBridge** _(interface)_ — `interface McpAppBridge`
  The author-facing global injected into a widget. Kept minimal and stable.
- **McpContentBlock** _(interface)_ — `interface McpContentBlock`
  A single content block in a tool result. Today only text — the model-facing representation.
- **McpHttpOptions** _(interface)_ — `interface McpHttpOptions`
- **McpPrompt** _(interface)_ — `interface McpPrompt`
- **McpPromptMessage** _(interface)_ — `interface McpPromptMessage`
- **McpProtocolOptions** _(interface)_ — `interface McpProtocolOptions`
- **McpProtocolState** _(interface)_ — `interface McpProtocolState`
- **McpResource** _(interface)_ — `interface McpResource`
- **McpServer** _(interface)_ — `interface McpServer`
- **McpServerFeatures** _(interface)_ — `interface McpServerFeatures`
- **McpTool** _(interface)_ — `interface McpTool`
- **McpToolAnnotations** _(interface)_ — `interface McpToolAnnotations`
  MCP tool safety hints (`readOnlyHint`/`destructiveHint`/…) surfaced in `tools/list`, per the MCP spec.
- **McpToolContext** _(interface)_ — `interface McpToolContext`
- **McpToolHandlerResult** _(type)_ — `type McpToolHandlerResult`
  The ergonomic result an MCP-tool handler may return (coerced to the protocol's {@link McpToolResult}).
- **McpToolResult** _(interface)_ — `interface McpToolResult`
  The rich result a tool handler may return instead of a bare string (MCP Apps). `content` is the model-facing text (also shown by text-only hosts); `structuredContent` is the data a linked `ui://` widget renders and is deliberately NOT added to the model's context; `_meta` carries the `ui.resourceUr…
- **McpUiIntent** _(type)_ — `type McpUiIntent = | "table" | "list" | "cards" | "form" | "metric" | "detail" | "chart" | (string & {})`
  A render-intent hint for GENERATIVE hosts: how to present the result's `structuredContent` when the host renders its OWN themed UI rather than an iframe widget. The host maps the intent to a component in its design system (a shadcn/Tailwind table, form, metric card, …). Open union — pick a known ta…
- **McpWidget** _(interface)_ — `interface McpWidget`
  A widget: the resource to register on the server, its `ui://` URI, and the `_meta` link for its tool.
- **PROTOCOL_VERSION** _(const)_ — `PROTOCOL_VERSION: "2024-11-05"`
  The pure MCP (Model Context Protocol) JSON-RPC dispatch — no I/O, no `Bun.*`, no side effects, so it unit-tests cleanly. A transport (stdio in `@nifrajs/cli`'s `mcp.ts`, Streamable-HTTP in {@link ./http.ts}) wires this to a byte stream; the tools/resources are injected, so the protocol logic is exe…
- **StandardIssue** _(interface)_ — `interface StandardIssue`
- **StandardResult** _(type)_ — `type StandardResult<Output> = | { readonly value: Output; readonly issues?: undefined } | { readonly issues: ReadonlyArray<StandardIssue> }`
- **StandardSchemaV1** _(interface)_ — `interface StandardSchemaV1<Input = unknown, Output = Input>`
  The Standard Schema v1 interface (https://standardschema.dev), vendored as types + a tiny runtime so any compliant validator - nifra's `t`, zod, valibot, arktype, … - can type and validate tool arguments without coupling this package to a validator. The spec is MIT-licensed and explicitly designed …
- **UI_EXTENSION_KEY** _(const)_ — `UI_EXTENSION_KEY: "io.modelcontextprotocol/ui"`
  The `capabilities.extensions` key advertising UI support in the `initialize` result (SEP-1865).
- **UI_MIME** _(const)_ — `UI_MIME: "text/html;profile=mcp-app"`
  The MIME type a UI resource MUST use so a host recognizes it as an MCP App widget (SEP-1865).
- **bridgeScript** _(function)_ — `bridgeScript: () => string`
  The bridge source, as a string for inlining in a `<script>`. Self-contained, no imports.
- **createMcpProtocolState** _(function)_ — `createMcpProtocolState: () => McpProtocolState`
- **createMcpServer** _(function)_ — `createMcpServer: (opts: CreateMcpServerOptions) => McpServer`
- **defineMcpTool** _(function)_ — `defineMcpTool: <S extends StandardSchemaV1 = UntypedArgs>(opts: DefineMcpToolOptions<S>) => McpTool`
- **defineMcpWidget** _(function)_ — `defineMcpWidget: (opts: DefineMcpWidgetOptions) => McpWidget`
- **handleRpc** _(function)_ — `handleRpc: (message: JsonRpcRequest, tools: readonly McpTool[], serverInfo: { name: string; version: string; }, features?: McpServerFeatures, options?: McpProtocolOptions) => Promise<JsonRpcResponse | null>`
  Dispatch one JSON-RPC message against the given tools. Returns the response, or `null` for a notification (no reply). Tool errors are reported in-band (`isError`) so the agent can react to them.
- **respondMcpHttp** _(function)_ — `respondMcpHttp: (request: Request, tools: McpTool[], serverInfo: { name: string; version: string; }, options?: McpHttpOptions) => Promise<Response>`
  Handle one MCP request over HTTP against the given `tools`/`features`. POST a JSON-RPC body → JSON-RPC response; GET → a plain-text health page; OPTIONS → CORS preflight. Never throws — a bad body becomes a JSON-RPC parse error. The dispatch is the shared, transport-agnostic {@link handleRpc}.
- **rpcError** _(const)_ — `rpcError: (id: JsonRpcId, code: number, message: string) => JsonRpcResponse`
- **rpcResult** _(const)_ — `rpcResult: (id: JsonRpcId, value: unknown) => JsonRpcResponse`
- **uiResourceMeta** _(function)_ — `uiResourceMeta: (uri: string) => Record<string, unknown>`
  The MCP Apps `_meta.ui.resourceUri` link.
- **widgetDocument** _(function)_ — `widgetDocument: (opts: DefineMcpWidgetOptions) => string`
  Assemble the full self-contained widget document (bridge inlined in `<head>` so body scripts can use `mcpApp` immediately).

### `@nifrajs/mcp/http`

- **McpHttpOptions** _(interface)_ — `interface McpHttpOptions`
- **respondMcpHttp** _(function)_ — `respondMcpHttp: (request: Request, tools: McpTool[], serverInfo: { name: string; version: string; }, options?: McpHttpOptions) => Promise<Response>`
  Handle one MCP request over HTTP against the given `tools`/`features`. POST a JSON-RPC body → JSON-RPC response; GET → a plain-text health page; OPTIONS → CORS preflight. Never throws — a bad body becomes a JSON-RPC parse error. The dispatch is the shared, transport-agnostic {@link handleRpc}.

### `@nifrajs/mcp/protocol`

- **JsonRpcNotification** _(interface)_ — `interface JsonRpcNotification`
- **JsonRpcRequest** _(interface)_ — `interface JsonRpcRequest`
- **JsonRpcResponse** _(type)_ — `type JsonRpcResponse = | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown } | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } }`
- **McpContentBlock** _(interface)_ — `interface McpContentBlock`
  A single content block in a tool result. Today only text — the model-facing representation.
- **McpPrompt** _(interface)_ — `interface McpPrompt`
- **McpPromptMessage** _(interface)_ — `interface McpPromptMessage`
- **McpProtocolOptions** _(interface)_ — `interface McpProtocolOptions`
- **McpProtocolState** _(interface)_ — `interface McpProtocolState`
- **McpResource** _(interface)_ — `interface McpResource`
- **McpServerFeatures** _(interface)_ — `interface McpServerFeatures`
- **McpTool** _(interface)_ — `interface McpTool`
- **McpToolAnnotations** _(interface)_ — `interface McpToolAnnotations`
  MCP tool safety hints (`readOnlyHint`/`destructiveHint`/…) surfaced in `tools/list`, per the MCP spec.
- **McpToolContext** _(interface)_ — `interface McpToolContext`
- **McpToolResult** _(interface)_ — `interface McpToolResult`
  The rich result a tool handler may return instead of a bare string (MCP Apps). `content` is the model-facing text (also shown by text-only hosts); `structuredContent` is the data a linked `ui://` widget renders and is deliberately NOT added to the model's context; `_meta` carries the `ui.resourceUr…
- **PROTOCOL_VERSION** _(const)_ — `PROTOCOL_VERSION: "2024-11-05"`
  The pure MCP (Model Context Protocol) JSON-RPC dispatch — no I/O, no `Bun.*`, no side effects, so it unit-tests cleanly. A transport (stdio in `@nifrajs/cli`'s `mcp.ts`, Streamable-HTTP in {@link ./http.ts}) wires this to a byte stream; the tools/resources are injected, so the protocol logic is exe…
- **UI_EXTENSION_KEY** _(const)_ — `UI_EXTENSION_KEY: "io.modelcontextprotocol/ui"`
  The `capabilities.extensions` key advertising UI support in the `initialize` result (SEP-1865).
- **UI_MIME** _(const)_ — `UI_MIME: "text/html;profile=mcp-app"`
  The MIME type a UI resource MUST use so a host recognizes it as an MCP App widget (SEP-1865).
- **createMcpProtocolState** _(function)_ — `createMcpProtocolState: () => McpProtocolState`
- **handleRpc** _(function)_ — `handleRpc: (message: JsonRpcRequest, tools: readonly McpTool[], serverInfo: { name: string; version: string; }, features?: McpServerFeatures, options?: McpProtocolOptions) => Promise<JsonRpcResponse | null>`
  Dispatch one JSON-RPC message against the given tools. Returns the response, or `null` for a notification (no reply). Tool errors are reported in-band (`isError`) so the agent can react to them.
- **rpcError** _(const)_ — `rpcError: (id: JsonRpcId, code: number, message: string) => JsonRpcResponse`
- **rpcResult** _(const)_ — `rpcResult: (id: JsonRpcId, value: unknown) => JsonRpcResponse`

### `@nifrajs/mcp/react`

- **ReactWidgetOptions** _(interface)_ — `interface ReactWidgetOptions`
- **reactWidget** _(function)_ — `reactWidget: (opts: ReactWidgetOptions) => Promise<McpWidget>`
  Build a {@link McpWidget} from a React component. Async — it bundles the component at definition time (a one-time cost at server start); pass the result to `createMcpServer({ widgets })` / a tool's `widget`.

## @nifrajs/mcp-db

- **McpDbAuthorizeContext** _(interface)_ — `interface McpDbAuthorizeContext`
  Context forwarded to `authorize` — the inbound HTTP Request carrying the `run_query` call.
- **McpDbConfigError** _(class)_ — `class McpDbConfigError`
- **RunQueryOptions** _(interface)_ — `interface RunQueryOptions`
- **ServeDatabaseAsMcpOptions** _(interface)_ — `interface ServeDatabaseAsMcpOptions`
- **SqliteDatabaseLike** _(interface)_ — `interface SqliteDatabaseLike`
  The structural slice of `bun:sqlite`'s `Database` this package needs.
- **serveDatabaseAsMcp** _(function)_ — `serveDatabaseAsMcp: (db: SqliteDatabaseLike, options: ServeDatabaseAsMcpOptions) => McpServer`
  Serve `db` as a mountable MCP server (`mcp.fetch` at `POST /mcp`). See module docs for the security model. Throws {@link McpDbConfigError} on any unsafe configuration — always at construction (boot), never at request time.

## @nifrajs/middleware

### `@nifrajs/middleware`

- **AdmissionControllerHandle** _(interface)_ — `interface AdmissionControllerHandle`
- **AdmissionEvidence** _(interface)_ — `interface AdmissionEvidence`
  Pure capacity evidence handed to the policy hook. The mechanics never invent tenant concepts.
- **AdmissionOptions** _(interface)_ — `interface AdmissionOptions`
- **AdmissionPolicy** _(type)_ — `type AdmissionPolicy = ( req: Request, evidence: AdmissionEvidence, ) => { decision: "admit" | "shed"; retryAfterSec?: number } | undefined`
  Application-supplied admission policy. Return a decision to override the default mechanics for this request, or `undefined` to defer to them. `admit` may draw from reserved headroom above `maxInFlight`; `shed` forces rejection.
- **AdmissionSnapshot** _(interface)_ — `interface AdmissionSnapshot`
- **ApiKeyStaticOptions** _(interface)_ — `interface ApiKeyStaticOptions`
- **ApiKeyVerifyOptions** _(interface)_ — `interface ApiKeyVerifyOptions<P>`
- **AuthPlugin** _(type)_ — `type AuthPlugin<P>`
  A token-auth plugin (`bearer` / `apiKey`). Apply it with `app.use(auth)` — it rejects unauthorized requests to **routes defined after it** with `401` (unless `optional`). Read the verified principal inside a handler/loader via {@link AuthPlugin.principal} (nullable) or {@link AuthPlugin.requirePrin…
- **BasicAuthPlugin** _(type)_ — `type BasicAuthPlugin<P> = NifraPlugin & { principal(request: Request): P | null requirePrincipal(request: Request): P }`
- **BasicAuthStaticOptions** _(interface)_ — `interface BasicAuthStaticOptions<P = string>`
- **BasicAuthVerifyOptions** _(interface)_ — `interface BasicAuthVerifyOptions<P>`
- **BearerOptions** _(interface)_ — `interface BearerOptions<P>`
- **BodyLimitOptions** _(interface)_ — `interface BodyLimitOptions`
- **CacheControlOptions** _(interface)_ — `interface CacheControlOptions`
- **CacheOptions** _(interface)_ — `interface CacheOptions`
- **CachedResponse** _(interface)_ — `interface CachedResponse`
- **Composable** _(type)_ — `type Composable = Middleware | NifraPlugin`
- **CompressionOptions** _(interface)_ — `interface CompressionOptions`
- **CorsOptions** _(interface)_ — `interface CorsOptions`
- **CsrfOptions** _(interface)_ — `interface CsrfOptions`
- **ETagOptions** _(interface)_ — `interface ETagOptions`
- **HealthcheckOptions** _(interface)_ — `interface HealthcheckOptions`
- **IdempotencyClaim** _(type)_ — `type IdempotencyClaim = | { readonly state: "new" } | { readonly state: "in_flight" } | { readonly state: "replay"; readonly record: IdempotencyRecord }`
- **IdempotencyOptions** _(interface)_ — `interface IdempotencyOptions`
- **IdempotencyRecord** _(interface)_ — `interface IdempotencyRecord`
  A captured response, replayed verbatim on a retry. Body is base64 (binary-safe + JSON-serializable).
- **IdempotencyStore** _(interface)_ — `interface IdempotencyStore`
  Store backing the idempotency guarantee. Production deploys MUST use a shared store so the key holds across instances; `begin` MUST be **atomic** (e.g. Redis `SET key NX PX lockTtlMs`) or two concurrent retries can both see `"new"`. {@link MemoryIdempotencyStore} is for dev / single-instance only.
- **IpMatcher** _(type)_ — `type IpMatcher = string | ((ip: string, request: Request) => MaybePromise<boolean>)`
- **IpRestrictionOptions** _(interface)_ — `interface IpRestrictionOptions`
- **JwkKey** _(interface)_ — `interface JwkKey`
- **JwksOptions** _(interface)_ — `interface JwksOptions`
- **JwtAlgorithm** _(type)_ — `type JwtAlgorithm = "HS256" | "HS384" | "HS512" | "RS256" | "RS384" | "RS512"`
- **JwtClaims** _(interface)_ — `interface JwtClaims`
- **JwtHeader** _(interface)_ — `interface JwtHeader`
- **JwtKeyResolver** _(type)_ — `type JwtKeyResolver = ( header: JwtHeader, claims: JwtClaims, ) => MaybePromise<JwtVerificationKey | null | undefined>`
- **JwtOptions** _(interface)_ — `interface JwtOptions`
- **JwtPlugin** _(type)_ — `type JwtPlugin<C extends JwtClaims = JwtClaims> = NifraPlugin & { claims(request: Request): C | null requireClaims(request: Request): C }`
- **JwtVerificationKey** _(type)_ — `type JwtVerificationKey = string | Uint8Array | CryptoKey | JwkKey`
- **LanguageMatch** _(interface)_ — `interface LanguageMatch`
- **LanguageOptions** _(interface)_ — `interface LanguageOptions<L extends readonly string[]>`
- **LoggerOptions** _(interface)_ — `interface LoggerOptions`
- **LoopDelayHistogram** _(interface)_ — `interface LoopDelayHistogram`
  The slice of a `perf_hooks` event-loop-delay histogram the sampler needs.
- **LoopDelayMonitor** _(type)_ — `type LoopDelayMonitor = (resolutionMs: number) => LoopDelayHistogram | undefined`
  Acquires a loop-delay histogram for a resolution, or `undefined` when the runtime has none. This is an optional test/runtime seam; the default sampler is a portable timer-drift monitor.
- **MemoryIdempotencyStore** _(class)_ — `class MemoryIdempotencyStore`
  In-process store. Refuses to run in production unless explicitly allowed (per-instance ⇒ no cross-instance dedupe).
- **MemoryIdempotencyStoreOptions** _(interface)_ — `interface MemoryIdempotencyStoreOptions`
- **MemoryResponseCache** _(class)_ — `class MemoryResponseCache`
- **MemoryResponseCacheOptions** _(interface)_ — `interface MemoryResponseCacheOptions`
- **MemoryStore** _(class)_ — `class MemoryStore`
  In-process fixed-window store. Refuses to run in production unless explicitly allowed.
- **MemoryStoreOptions** _(interface)_ — `interface MemoryStoreOptions`
- **MethodOverrideOptions** _(interface)_ — `interface MethodOverrideOptions`
- **OpenApiInfo** _(interface)_ — `interface OpenApiInfo`
- **OpenApiOptions** _(interface)_ — `interface OpenApiOptions`
- **OpenApiServer** _(interface)_ — `interface OpenApiServer`
- **OpenApiTag** _(interface)_ — `interface OpenApiTag`
- **OpenApiUiOptions** _(interface)_ — `interface OpenApiUiOptions`
  Scalar API-reference UI options.
- **PoweredByOptions** _(interface)_ — `interface PoweredByOptions`
- **PrettyJsonOptions** _(interface)_ — `interface PrettyJsonOptions`
- **RateLimitOptions** _(interface)_ — `interface RateLimitOptions`
- **RateLimitResult** _(interface)_ — `interface RateLimitResult`
- **RateLimitStore** _(interface)_ — `interface RateLimitStore`
  Counter backend. Production deploys MUST use a shared store (Redis, etc.) so the limit holds across instances — that's a user dependency, not ours, hence the interface. {@link MemoryStore} is for dev / single-instance only.
- **RequestIdOptions** _(interface)_ — `interface RequestIdOptions`
- **RequestLogFields** _(interface)_ — `interface RequestLogFields`
  Structured fields logged per request.
- **ResponseCacheStore** _(interface)_ — `interface ResponseCacheStore`
- **RouteLike** _(interface)_ — `interface RouteLike`
  A registered route as seen by {@link buildOpenApiDocument} — structurally a `@nifrajs/core` `RouteDescriptor` (so `app.routes()` is passed straight through).
- **SecurityHeadersOptions** _(interface)_ — `interface SecurityHeadersOptions`
- **SecurityRequirement** _(type)_ — `type SecurityRequirement = Readonly<Record<string, readonly string[]>>`
  A security requirement: scheme name → required scopes (`[]` = no scopes).
- **ShedReason** _(type)_ — `type ShedReason = "inflight" | "loop-lag" | "queue-timeout" | "policy" | "cancelled"`
  Adaptive capacity admission. Rate limiting bounds request *frequency* and `@nifrajs/core/budget` bounds request *duration*; neither stops a healthy instance from accepting more *concurrent* work than it can finish. This gate admits on live capacity evidence — in-flight count + event-loop lag — brie…
- **TimingControls** _(interface)_ — `interface TimingControls`
- **TimingMetric** _(interface)_ — `interface TimingMetric`
- **TimingOptions** _(interface)_ — `interface TimingOptions`
- **TrailingSlashOptions** _(interface)_ — `interface TrailingSlashOptions`
- **VerifiedJwt** _(interface)_ — `interface VerifiedJwt<C extends JwtClaims = JwtClaims>`
- **VerifyJwtOptions** _(interface)_ — `interface VerifyJwtOptions`
- **VerifyJwtResult** _(type)_ — `type VerifyJwtResult<C extends JwtClaims = JwtClaims> = | { readonly ok: true; readonly data: VerifiedJwt<C> } | { readonly ok: false; readonly error: Error }`
- **apiKey** _(function)_ — `apiKey: { (options: ApiKeyStaticOptions): AuthPlugin<string>; <P>(options: ApiKeyVerifyOptions<P>): AuthPlugin<P>; }`
  API-key authentication via a header (default `x-api-key`). Two forms: - `apiKey({ keys })` — a fixed key set, compared in **constant time**; the matched key is the principal. - `apiKey({ verify })` — custom (e.g. DB-backed) verification returning a typed principal.
- **appendTrailingSlash** _(function)_ — `appendTrailingSlash: (options?: TrailingSlashOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  Append a trailing slash to non-root paths. By default it skips file-looking paths such as `/app.css`, which keeps static assets and extensionful API routes stable.
- **basicAuth** _(function)_ — `basicAuth: { (options: BasicAuthStaticOptions): BasicAuthPlugin<string>; <P>(options: BasicAuthStaticOptions<P>): BasicAuthPlugin<P>; <P>(options: BasicAuthVerifyOptions<P>): BasicAuthPlugin<P>; }`
  HTTP Basic authentication. Prefer short-lived Basic Auth for internal tools and staging gates, not public user login. Static credentials are compared in constant time after SHA-256 hashing; the callback form is available for external stores.
- **bearer** _(function)_ — `bearer: <P>(options: BearerOptions<P>) => AuthPlugin<P>`
  `Authorization: Bearer <token>` authentication. Parses the header, runs `verify`, and rejects with `401` (+ `WWW-Authenticate: Bearer`) when the token is missing/invalid (unless `optional`). The verified principal is read via the returned instance — see {@link AuthPlugin}.
- **bodyLimit** _(function)_ — `bodyLimit: (options: BodyLimitOptions) => Middleware`
  Enforce a raw byte cap for request bodies before routing. This middleware is intentionally Content-Length based: reading a cloned Web body is not transparent on every runtime. Lengthless bodies fail closed by default; use route-level `c.boundedBody()` / schema validation for endpoints that intentio…
- **buildOpenApiDocument** _(function)_ — `buildOpenApiDocument: (routes: readonly RouteLike[], options?: OpenApiOptions) => Record<string, unknown>`
  Build an OpenAPI 3.1 document from a route list. Delegates to `@nifrajs/schema`'s `toOpenAPI`, so a route validated with `t` (TypeBox) emits full field-level request/query/response schemas plus `$ref`-reused `components.schemas`; a BYO Standard Schema (zod/valibot/arktype) exposes no portable JSON-…
- **cache** _(function)_ — `cache: (options: CacheOptions) => Middleware`
  Full response cache for small, cacheable responses. Use a shared `store` in production. The middleware honors `Cache-Control` by default, avoids `Set-Cookie`, caps stored bytes, emits `Age`, and keeps `Vary` headers aligned with the cache key.
- **cacheControl** _(function)_ — `cacheControl: (value: string | ((request: Request) => string | undefined), options?: CacheControlOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  Set a `Cache-Control` header on matching responses. `value` is either a fixed directive string or a function of the request (return `undefined` to leave a response untouched — e.g. cache by path). Defaults to `GET`/`HEAD` + 2xx, and never clobbers a `Cache-Control` the handler set itself.
- **combine** _(function)_ — `combine: (...items: readonly Composable[]) => NifraPlugin`
  Compose middleware/plugins into one reusable bundle. Individual named plugins still dedupe.
- **compression** _(function)_ — `compression: (options?: CompressionOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  Transparently **gzip** responses when the client sends `Accept-Encoding: gzip` and the body is a compressible type larger than `threshold`. Uses the Web-standard `CompressionStream` (streaming, no full-body buffering), so it runs on every nifra runtime including the edge. gzip is the one encoding `…
- **cors** _(function)_ — `cors: (options?: CorsOptions) => Middleware`
  CORS as a {@link Middleware}. Preflight (`OPTIONS` + `Access-Control-Request-Method`) short-circuits to `204` via `onRequest`; the origin/credentials headers are added in `onResponse`, so they also land on errors, 404s, and the preflight itself.
- **createAdmissionController** _(function)_ — `createAdmissionController: (options: AdmissionOptions) => AdmissionControllerHandle`
  Build a capacity-admission controller. Pass the returned handle as the server's `admission` option.
- **createCsrfToken** _(function)_ — `createCsrfToken: (secret: string | Uint8Array, nonce?: string) => Promise<string>`
- **createEventLoopLagSampler** _(function)_ — `createEventLoopLagSampler: (resolutionMs?: number, monitor?: LoopDelayMonitor) => () => number`
  Event-loop-lag sampler. By default it measures timer drift using only Web/JS runtime primitives, so it works under Node ESM, Bun, Deno, and workers without a hidden CommonJS `require` fallback. An injected histogram remains available for deterministic tests or a runtime-native monitor. Each read re…
- **csrf** _(function)_ — `csrf: (options: CsrfOptions) => Middleware`
  Signed double-submit CSRF protection. A protected request must carry the same signed token in a cookie and a header, and must come from an allowed Origin/Referer unless `checkOrigin:false` is set.
- **etag** _(function)_ — `etag: (options?: ETagOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  A {@link definePlugin} plugin that adds a content-hash `ETag` to `GET` `200` responses and returns **`304 Not Modified`** when the client's `If-None-Match` matches — saving bandwidth on unchanged responses. It reads and rebuilds small bodies only; larger responses pass through unchanged. Idempotent.
- **healthcheck** _(function)_ — `healthcheck: (options?: HealthcheckOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  Register **liveness** (`/health`) and **readiness** (`/ready`) endpoints. Liveness is a flat `200` (the process is serving). Readiness runs each `check` and returns `200 { status: "ok", checks }` when all pass, or `503 { status: "error", checks }` when any fail (a thrown check counts as failed). Bo…
- **idempotency** _(function)_ — `idempotency: (options: IdempotencyOptions) => Middleware`
- **ipRestriction** _(function)_ — `ipRestriction: (options: IpRestrictionOptions) => Middleware`
  IP allow/deny middleware. It fails closed when no trustworthy client IP can be derived. Configure `clientIp`, `trustedProxies`, or a trusted single-IP `header`; unconfigured X-Forwarded-For is never trusted.
- **jwk** _(function)_ — `jwk: (key: JwtVerificationKey) => JwtKeyResolver`
- **jwks** _(function)_ — `jwks: (options: JwksOptions) => JwtKeyResolver`
- **jwt** _(function)_ — `jwt: <C extends JwtClaims = JwtClaims>(options: JwtOptions) => JwtPlugin<C>`
- **language** _(function)_ — `language: <const L extends readonly string[]>(options: LanguageOptions<L>) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").Server<any, any>>`
  Derives `c.language` from `Accept-Language` and emits `Content-Language` by default.
- **logger** _(function)_ — `logger: (options?: LoggerOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  A {@link definePlugin} plugin that logs one structured line per request — method, path, status, and duration — via `onRequest`/`onResponse` (so it covers 404s and errors too). The start time is paired to the request through a `WeakMap` (no per-request allocation leak). Idempotent.
- **methodOverride** _(function)_ — `methodOverride: (options?: MethodOverrideOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  HTTP method override for clients that can only send `POST`. The middleware rewrites the request before routing, so handlers, validation, and response hooks all see the overridden method.
- **namedCombine** _(function)_ — `namedCombine: (name: string, ...items: readonly Composable[]) => NifraPlugin`
  Compose middleware/plugins into one idempotent named bundle.
- **openapi** _(function)_ — `openapi: (options?: OpenApiOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  Serve an OpenAPI 3.1 document (a structural subset — see {@link buildOpenApiDocument}) at `options.path` (default `/openapi.json`), generated from the app's registered routes. Generation is **lazy + memoized**: it reads `app.routes()` on the first request, by which point every route is registered —…
- **pickLanguage** _(function)_ — `pickLanguage: <const L extends readonly string[]>(header: string | null, supported: L, defaultLanguage: L[number]) => LanguageMatch`
  Pick the best supported language for an `Accept-Language` header. Exact tags win, then compatible base-language matches, then `*`, then the configured default.
- **poweredBy** _(function)_ — `poweredBy: (options?: PoweredByOptions) => Middleware`
  Opt-in `X-Powered-By` style header. Nifra does not emit this by default; use it only when you want a public framework/product marker.
- **prettyJson** _(function)_ — `prettyJson: (options?: PrettyJsonOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  Pretty-print JSON responses for debugging and developer-facing APIs. It only touches JSON content, skips encoded responses, caps inspection size, and leaves invalid JSON untouched.
- **rateLimit** _(function)_ — `rateLimit: (options: RateLimitOptions) => Middleware`
  Rate limiting as a {@link Middleware}. Runs in `onRequest` (before routing, so it also covers 404s); over the limit → `429` + `Retry-After`. Every response carries `RateLimit-Limit/Remaining/Reset` (added in `onResponse`, keyed off the request).
- **requestId** _(function)_ — `requestId: (options?: RequestIdOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").Server<any, any>>`
  A {@link definePlugin} plugin that gives every request a stable id: it reuses an inbound `x-request-id` (or generates one), exposes it on the handler context as **`c.requestId`** (typed, threaded by `derive`), and echoes it on the response header. Idempotent — applying it twice is a no-op.
- **responseCache** _(const)_ — `responseCache: (options: CacheOptions) => Middleware`
- **securityHeaders** _(function)_ — `securityHeaders: (options?: SecurityHeadersOptions) => Middleware`
  A safe-by-default set of response security headers (`onResponse`, so they cover errors and 404s too): `X-Content-Type-Options: nosniff`, `X-Frame-Options`, and `Referrer-Policy` always; `Strict-Transport-Security` and `Content-Security-Policy` only when configured (both are environment-/app-specifi…
- **timing** _(function)_ — `timing: (options?: TimingOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").Server<any, any>>`
  Adds a `Server-Timing` response header and typed `c.timing` controls for custom metrics. Put request-rewriting middleware (for example `methodOverride`) before `timing()` so timing is attached to the final routed request.
- **trimTrailingSlash** _(function)_ — `trimTrailingSlash: (options?: TrailingSlashOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  Remove trailing slashes from non-root paths. Redirect mode is the production default because it canonicalizes URLs for clients and caches; rewrite mode is available for compatibility migrations.
- **tryVerifyJwt** _(function)_ — `tryVerifyJwt: <C extends JwtClaims = JwtClaims>(token: string, options: VerifyJwtOptions) => Promise<VerifyJwtResult<C>>`
- **verifyCsrfToken** _(function)_ — `verifyCsrfToken: (token: string, secret: string | Uint8Array) => Promise<boolean>`
- **verifyJwt** _(function)_ — `verifyJwt: <C extends JwtClaims = JwtClaims>(token: string, options: VerifyJwtOptions) => Promise<VerifiedJwt<C>>`

### `@nifrajs/middleware/context-storage`

- **contextStorage** _(function)_ — `contextStorage: () => Middleware`
  Store the current nifra `Context` in `AsyncLocalStorage` for helpers that run away from the handler argument, e.g. repository/logger functions called deep in the stack.
- **getContext** _(function)_ — `getContext: <C extends Context = Context<string, import("@nifrajs/core").RouteSchema>>() => C`
  Return the current request context, or throw when no context-storage wrapper is active.
- **tryGetContext** _(function)_ — `tryGetContext: <C extends Context = Context<string, import("@nifrajs/core").RouteSchema>>() => C | undefined`
  Return the current request context, or `undefined` outside a context-storage request.

## @nifrajs/mock

- **MockServer** _(interface)_ — `interface MockServer`
- **MockServerOptions** _(interface)_ — `interface MockServerOptions`
- **MockableApp** _(interface)_ — `interface MockableApp`
  App shape — anything with a `routes()` method.
- **MockableRoute** _(interface)_ — `interface MockableRoute`
  Minimal route shape returned by `app.routes()`.
- **UnsupportedMockSchemaError** _(class)_ — `class UnsupportedMockSchemaError`
- **createMockServer** _(function)_ — `createMockServer: (app: MockableApp, options?: MockServerOptions | undefined) => MockServer`
  Create a mock server from a Nifra app's route definitions. For each route with a `schema.response`, generates a handler returning fake data that matches the response schema structure. Routes without response schemas return `{}`.
- **generateMockValue** _(function)_ — `generateMockValue: (schema: unknown, fieldName?: string | undefined, rng?: (() => number) | undefined) => unknown`
  Generate a mock value from a schema object. Inspects JSON Schema properties (`type`, `properties`, `items`, `enum`, `format`) that TypeBox / NifraSchema objects carry directly. Unsupported constraints fail closed with {@link UnsupportedMockSchemaError} rather than returning a known-invalid response.

## @nifrajs/node

- **FetchHandler** _(interface)_ — `interface FetchHandler`
  Anything exposing a Web `fetch` handler — a nifra `app`, for instance.
- **NodeServer** _(interface)_ — `interface NodeServer`
- **RequestProtocol** _(type)_ — `type RequestProtocol = "http" | "https"`
- **RequestProtocolOption** _(type)_ — `type RequestProtocolOption = | RequestProtocol | ((request: IncomingMessage) => RequestProtocol)`
- **ServeOptions** _(interface)_ — `interface ServeOptions`
- **ServeStaticOptions** _(interface)_ — `interface ServeStaticOptions`
  Serve static files from a directory (e.g. the client build) under a URL prefix — so a self-hosted Node deploy doesn't need a CDN or a hand-rolled `/assets/*` handler. (On Cloudflare/Vercel the platform serves assets; this is for `node server.js`.)
- **serve** _(function)_ — `serve: (app: FetchHandler, options: ServeOptions) => Promise<NodeServer>`

## @nifrajs/otel

### `@nifrajs/otel`

- **ActiveObservation** _(interface)_ — `interface ActiveObservation`
- **AttributeValue** _(type)_ — `type AttributeValue = string | number | boolean`
- **EndObservation** _(interface)_ — `interface EndObservation`
- **NifraSpan** _(interface)_ — `interface NifraSpan`
  A completed (or in-flight) server span for one request.
- **ObservationAdapter** _(interface)_ — `interface ObservationAdapter`
  Where ended spans go. Implement this to bridge to the OpenTelemetry SDK (map each field onto a real `Span` from a `Tracer`), ship to a collector, or just log. `onStart` is optional (most backends only need the completed span).
- **ObservationClock** _(interface)_ — `interface ObservationClock`
- **ObservationContext** _(interface)_ — `interface ObservationContext`
- **ObservationLifecycle** _(interface)_ — `interface ObservationLifecycle`
- **ObservationLifecycleOptions** _(interface)_ — `interface ObservationLifecycleOptions`
- **ObservationLink** _(interface)_ — `interface ObservationLink`
  A non-parent causal relationship to a span in another trace (the OTel `Link` model).
- **ObservationParent** _(interface)_ — `interface ObservationParent`
- **OtlpExporter** _(interface)_ — `interface OtlpExporter`
- **OtlpExporterOptions** _(interface)_ — `interface OtlpExporterOptions`
- **ParsedTraceparent** _(interface)_ — `interface ParsedTraceparent`
  A parsed inbound `traceparent`.
- **SpanStatus** _(type)_ — `type SpanStatus = "unset" | "ok" | "error"`
  The span model + exporter seam. Attribute names follow OpenTelemetry HTTP semantic conventions (`http.request.method`, `url.path`, `http.response.status_code`, …) so a span maps cleanly onto an OTel `Span` when bridged — but nothing here depends on the OTel SDK. You supply an {@link ObservationAdap…
- **StartObservation** _(interface)_ — `interface StartObservation`
- **TraceContext** _(type)_ — `type TraceContext = ObservationContext`
  The trace context exposed on the handler `c.trace` (typed, threaded via `derive`).
- **TracingOptions** _(interface)_ — `interface TracingOptions`
- **causalitySpanLink** _(function)_ — `causalitySpanLink: (context: CausalityContext) => ObservationLink | undefined`
  Convert the nearest observed causal ancestor into an OTel span link. Returns `undefined` instead of inventing a trace identity when the durable context has no observation anchor.
- **combineObservationAdapters** _(function)_ — `combineObservationAdapters: (adapters: readonly ObservationAdapter[]) => ObservationAdapter`
  Fan out lifecycle notifications to several adapters. Each adapter is isolated: an exception in one sink cannot prevent the remaining sinks from observing the span.
- **consoleSpanExporter** _(function)_ — `consoleSpanExporter: (log?: (line: string) => void) => ObservationAdapter`
  A no-frills exporter that logs each completed span as one structured line. Useful in dev or as a starting point before wiring a real backend.
- **createObservationLifecycle** _(function)_ — `createObservationLifecycle: (options?: ObservationLifecycleOptions) => ObservationLifecycle`
  Creates an independent lifecycle factory. Adapters are always called fail-open.
- **formatTraceparent** _(function)_ — `formatTraceparent: (traceId: string, spanId: string, sampled: boolean) => string`
  Format a `traceparent` header value (version `00`).
- **generateSpanId** _(function)_ — `generateSpanId: () => string`
  A fresh 8-byte (16-hex) span id.
- **generateTraceId** _(function)_ — `generateTraceId: () => string`
  A fresh 16-byte (32-hex) trace id.
- **otlpExporter** _(function)_ — `otlpExporter: (options: OtlpExporterOptions) => OtlpExporter`
- **parseTraceparent** _(function)_ — `parseTraceparent: (header: string | null | undefined) => ParsedTraceparent | null`
  Parse a `traceparent` header, or `null` if it's absent/malformed/version-unknown — per the spec, a bad header means "start a fresh trace", never an error. Only version `00` is accepted.
- **traceHeaders** _(function)_ — `traceHeaders: (trace: TraceContext, causality?: CausalityContext) => { readonly traceparent: string; } & Readonly<Record<string, string>>`
  Spread into an outgoing `fetch`/`ctx.api` call's headers to continue the trace downstream: `fetch(url, { headers: traceHeaders(c.trace) })`.
- **tracing** _(function)_ — `tracing: (options?: TracingOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").Server<any, any>>`
  Distributed-tracing plugin. Each request continues the inbound trace (or starts one), opens a server span, and ends it on response with the status + HTTP attributes. Idempotent.

### `@nifrajs/otel/metrics`

- **Counter** _(class)_ — `class Counter`
  A monotonically increasing counter (requests, errors).
- **Gauge** _(class)_ — `class Gauge`
  A value that can go up and down (in-flight requests, queue depth).
- **Histogram** _(class)_ — `class Histogram`
  Latency-style distribution over fixed buckets (seconds). Renders Prometheus cumulative buckets.
- **MetricsOptions** _(interface)_ — `interface MetricsOptions`
- **MetricsRegistry** _(class)_ — `class MetricsRegistry`
  A collection of metrics that renders one Prometheus exposition document.
- **createMetricsRegistry** _(function)_ — `createMetricsRegistry: () => MetricsRegistry`
  Create a standalone registry to register custom app metrics on, shared into `metrics({ registry })`.
- **metrics** _(function)_ — `metrics: (options?: MetricsOptions) => NifraPlugin`
  Enable RED metrics + a `/metrics` Prometheus endpoint. Records `nifra_http_requests_total`, `nifra_http_request_duration_seconds`, and `nifra_http_requests_in_flight`, labeled by method, matched route template, and status. Apply once (named-plugin dedupe).

## @nifrajs/prompt

- **Prompt** _(interface)_ — `interface Prompt<Input, Output>`
- **PromptInputError** _(class)_ — `class PromptInputError`
  A failed prompt input — the caller's variables did not satisfy the input schema.
- **PromptMessage** _(interface)_ — `interface PromptMessage`
  One chat message. The union every provider API accepts.
- **PromptOutputError** _(class)_ — `class PromptOutputError`
  The model's reply did not satisfy the output schema (after any heal attempts).
- **PromptRequest** _(interface)_ — `interface PromptRequest`
  Everything a provider adapter needs to execute one prompt call.
- **PromptResponseFormat** _(interface)_ — `interface PromptResponseFormat`
  The structured-output format handed to the provider (OpenAI `json_schema` shape; trivially adaptable to Anthropic tool-input or Gemini `responseSchema`).
- **RunOptions** _(interface)_ — `interface RunOptions`
- **prompt** _(function)_ — `prompt: (instruction: string) => Prompt<undefined, string>`
  Define a type-safe prompt. Chain `.input()` / `.output()` with Standard Schemas, then `.run()` with a provider `complete` fn. Immutable — each chain step returns a new prompt.

## @nifrajs/runner

- **AppLike** _(interface)_ — `interface AppLike`
  Anything with a Web-standard fetch handler — a nifra app, or any `(Request) => Response`. Declared structurally so this package has zero dependency on `@nifrajs/core`.
- **RequestSpec** _(interface)_ — `interface RequestSpec`
  One request to drive through the app.
- **RunOptions** _(interface)_ — `interface RunOptions`
- **RunResult** _(interface)_ — `interface RunResult`
  The captured outcome of one request.
- **runApp** _(function)_ — `runApp: (app: AppLike, requests: readonly RequestSpec[], options?: RunOptions) => Promise<RunResult[]>`
  Run a batch of requests through the app, in order, and return a result per request. Never throws: an app crash on any request is captured as that result's `error` and the run continues.
- **runRequest** _(function)_ — `runRequest: (app: AppLike, spec: RequestSpec, options?: RunOptions) => Promise<RunResult>`
  Drive a single request through the app, capturing the outcome (never throws — a thrown app error becomes `result.error`).

## @nifrajs/schema

### `@nifrajs/schema`

- **NifraSchema** _(type)_ — `type NifraSchema<T extends TSchema = TSchema> = StandardSchemaV1<Static<T>, Static<T>> & { readonly jsonSchema: T }`
  A `t` schema. It is a Standard Schema (so any nifra route validates it with no special-casing) whose raw TypeBox definition stays reachable as `jsonSchema` — and because a TypeBox schema *is* a JSON Schema, that field is exactly what lets `toOpenAPI` emit a real request/response schema for the rout…
- **OpenAPIDocument** _(interface)_ — `interface OpenAPIDocument`
- **OpenAPIInfo** _(interface)_ — `interface OpenAPIInfo`
  OpenAPI 3.1 generation. We model a practical slice of the spec — enough to feed Swagger UI / codegen and to validate structurally: paths, parameters, request bodies, responses (incl. non-200 and non-JSON), tags, security, servers, and `$ref` reuse via `components.schemas`.
- **Page** _(interface)_ — `interface Page<Item>`
  A cursor-pagination page — matches the shape of `t.paginated(item)`.
- **decodeCursor** _(function)_ — `decodeCursor: <T = unknown>(cursor: string | null | undefined) => T | undefined`
  Decode a cursor back to its value. Returns `undefined` for a null/empty/malformed cursor — treat that as "start from the beginning" rather than erroring on a client-supplied string.
- **encodeCursor** _(function)_ — `encodeCursor: (value: unknown) => string`
  Encode any JSON-serializable value (e.g. the last row's sort key) into an opaque cursor string.
- **fromTypeBox** _(function)_ — `fromTypeBox: <T extends TSchema>(schema: T, options?: { readonly coerce?: boolean; }) => NifraSchema<T>`
  Wrap a TypeBox schema as a `NifraSchema`.
- **paginate** _(function)_ — `paginate: <Row>(rows: readonly Row[], limit: number, cursorOf: (row: Row) => unknown) => Page<Row>`
  Build a page from rows you fetched with `limit + 1`. If the extra row came back there are more pages: drop it and emit a `nextCursor` from the last KEPT row via `cursorOf`; otherwise `nextCursor` is `null`.
- **registerFormat** _(function)_ — `registerFormat: (name: string, validate: (value: string) => boolean) => void`
  Register (or override) a string format usable as `t.string({ format: name })`.
- **t** _(const)_ — `t: { readonly string: (options?: StringOptions) => NifraSchema<import("@sinclair/typebox").TString>; readonly number: (options?: NumberOptions) => NifraSchema<import("@sinclair/typebox").TNumber>; readonly integer: (opt…`
  The built-in schema builder. Each constructor returns a `NifraSchema` — a Standard Schema whose validated output type flows into `c.body`/`c.query`, and whose `jsonSchema` powers `toOpenAPI`. Options (min/max, length, pattern, …) pass straight through to TypeBox and so become JSON Schema constraint…
- **toOpenAPI** _(function)_ — `toOpenAPI: (input: ContractShape | Server, options?: ToOpenAPIOptions) => OpenAPIDocument`
  Generate an OpenAPI 3.1 document from a contract or a running app. See the module doc for the detail model.

### `@nifrajs/schema/openapi`

- **OpenAPIDocument** _(interface)_ — `interface OpenAPIDocument`
- **OpenAPIInfo** _(interface)_ — `interface OpenAPIInfo`
  OpenAPI 3.1 generation. We model a practical slice of the spec — enough to feed Swagger UI / codegen and to validate structurally: paths, parameters, request bodies, responses (incl. non-200 and non-JSON), tags, security, servers, and `$ref` reuse via `components.schemas`.
- **OpenAPIServer** _(interface)_ — `interface OpenAPIServer`
- **OpenAPITag** _(interface)_ — `interface OpenAPITag`
- **SecurityRequirement** _(type)_ — `type SecurityRequirement = Readonly<Record<string, readonly string[]>>`
  A document-wide / per-operation security requirement: scheme name → required scopes.
- **ToOpenAPIOptions** _(interface)_ — `interface ToOpenAPIOptions`
- **toOpenAPI** _(function)_ — `toOpenAPI: (input: ContractShape | Server, options?: ToOpenAPIOptions) => OpenAPIDocument`
  Generate an OpenAPI 3.1 document from a contract or a running app. See the module doc for the detail model.

## @nifrajs/storage

- **FileStorage** _(class)_ — `class FileStorage`
- **ListOptions** _(interface)_ — `interface ListOptions`
- **MemoryStorage** _(class)_ — `class MemoryStorage`
- **MovableStorageAdapter** _(interface)_ — `interface MovableStorageAdapter`
  Optional server-side copy/move capability.
- **PagedStorageAdapter** _(interface)_ — `interface PagedStorageAdapter`
  Optional cursor-listing capability. Kept out of {@link StorageAdapter} for simple stores.
- **PresignableStorageAdapter** _(interface)_ — `interface PresignableStorageAdapter`
  Optional provider-side URL-signing capability. Asset sensitivity and TTL policy stay with callers.
- **PutOptions** _(interface)_ — `interface PutOptions`
- **R2BucketLike** _(interface)_ — `interface R2BucketLike`
  The slice of the R2 bucket binding this adapter calls. `env.<BUCKET>` satisfies it.
- **R2ObjectLike** _(interface)_ — `interface R2ObjectLike`
  The slice of R2's object metadata this adapter reads.
- **R2Storage** _(class)_ — `class R2Storage`
- **StorageAdapter** _(interface)_ — `interface StorageAdapter`
  A blob store keyed by string. Keys are POSIX-ish paths (`avatars/u1.png`); every adapter rejects unsafe keys (absolute, `..` traversal, NUL, backslash) so a key valid in one adapter is valid in all. All methods are async.
- **StorageAdapterConformanceError** _(class)_ — `class StorageAdapterConformanceError`
  A failed invariant reported by {@link assertStorageAdapterConformance}.
- **StorageAdapterConformanceOptions** _(interface)_ — `interface StorageAdapterConformanceOptions`
  Construction and cleanup hooks for {@link assertStorageAdapterConformance}.
- **StorageData** _(type)_ — `type StorageData = Uint8Array | ArrayBuffer | string`
  Accepted `put` payloads — normalized to bytes by each adapter.
- **StorageKeyError** _(class)_ — `class StorageKeyError`
  Storage-key safety. A key is a POSIX-ish relative path (`avatars/u1.png`); we reject anything that could escape a `FileStorage` root or otherwise misbehave — absolute paths, `..` traversal, NUL bytes, and backslashes (Windows traversal). Enforced by EVERY adapter (not just `FileStorage`) so a key i…
- **StorageListPage** _(interface)_ — `interface StorageListPage`
  One page of keys from stores that expose cursor-based listing.
- **StorageListPageOptions** _(interface)_ — `interface StorageListPageOptions`
  Cursor-aware listing options. `cursor` is adapter-owned and must be treated as opaque.
- **StorageObject** _(interface)_ — `interface StorageObject`
  An object read back from storage. `body` is buffered (not streamed) — fine for typical uploads.
- **StoragePresignOperation** _(type)_ — `type StoragePresignOperation = "get" | "put"`
  Operation represented by a presigned storage URL.
- **StoragePresignOptions** _(interface)_ — `interface StoragePresignOptions`
  Mechanical constraints applied while minting a presigned URL.
- **StoragePresignedUrl** _(interface)_ — `interface StoragePresignedUrl`
  A provider-minted URL and its known expiry.
- **assertSafeKey** _(function)_ — `assertSafeKey: (key: string) => void`
  Throw {@link StorageKeyError} unless `key` is a safe relative storage key.
- **assertStorageAdapterConformance** _(function)_ — `assertStorageAdapterConformance: (options: StorageAdapterConformanceOptions) => Promise<void>`
  Execute the observable {@link StorageAdapter} contract without depending on a test runner.
- **toBytes** _(function)_ — `toBytes: (data: StorageData) => Uint8Array`
  Normalize any accepted payload to bytes.

## @nifrajs/testing

### `@nifrajs/testing`

- **AdapterCertificationError** _(class)_ — `class AdapterCertificationError`
- **AdapterCertificationProfile** _(interface)_ — `interface AdapterCertificationProfile<Adapter>`
- **AdapterCertificationReport** _(interface)_ — `interface AdapterCertificationReport`
- **AdversarialContractError** _(class)_ — `class AdversarialContractError`
- **AdversarialContractOptions** _(interface)_ — `interface AdversarialContractOptions`
- **AdversarialContractReport** _(interface)_ — `interface AdversarialContractReport`
- **AdversarialContractResult** _(interface)_ — `interface AdversarialContractResult`
- **AppLike** _(interface)_ — `interface AppLike`
  The minimal shape a nifra `server()` app satisfies — its own `fetch`.
- **CaptureIncidentOptions** _(interface)_ — `interface CaptureIncidentOptions`
- **CapturedRequest** _(interface)_ — `interface CapturedRequest`
- **CapturedRequestInput** _(interface)_ — `interface CapturedRequestInput`
- **CertifiableCacheEntry** _(interface)_ — `interface CertifiableCacheEntry`
- **CertifiableCacheStore** _(interface)_ — `interface CertifiableCacheStore`
- **CertifiableDomainEvent** _(interface)_ — `interface CertifiableDomainEvent`
- **CertifiableEventDeliveryAdapter** _(interface)_ — `interface CertifiableEventDeliveryAdapter`
- **CertifiableEventRecord** _(interface)_ — `interface CertifiableEventRecord`
- **CertifiableJobStore** _(interface)_ — `interface CertifiableJobStore`
- **CertifiableRuntimeAdapter** _(interface)_ — `interface CertifiableRuntimeAdapter`
- **CertifiableRuntimeServer** _(interface)_ — `interface CertifiableRuntimeServer`
- **CertifiableStorageAdapter** _(interface)_ — `interface CertifiableStorageAdapter`
- **CertificationCapabilityEvidence** _(interface)_ — `interface CertificationCapabilityEvidence`
- **CertificationCheck** _(interface)_ — `interface CertificationCheck<Adapter>`
- **CertificationCheckEvidence** _(interface)_ — `interface CertificationCheckEvidence`
- **ContractCaseContext** _(interface)_ — `interface ContractCaseContext`
  Stable context passed to request/rejection hooks. It contains no request payloads or secrets.
- **ContractCaseKind** _(type)_ — `type ContractCaseKind = "input-rejection" | "response-conformance"`
- **ContractCoverageGap** _(interface)_ — `interface ContractCoverageGap`
- **ContractCoverageGapCode** _(type)_ — `type ContractCoverageGapCode`
- **ContractReplay** _(interface)_ — `interface ContractReplay`
- **ContractRuntime** _(interface)_ — `interface ContractRuntime`
  A runtime target for the same generated contract cases (for example Bun, Node, and Workers).
- **ContractTarget** _(type)_ — `type ContractTarget = "body" | "query" | "response"`
- **ContractTestApp** _(interface)_ — `interface ContractTestApp`
  Anything that exposes reflected routes and a Web-standard in-process fetch handler.
- **ContractWitness** _(interface)_ — `interface ContractWitness`
  A known-good request. Missing body/query values are synthesized from inspectable JSON Schema.
- **CookieJar** _(interface)_ — `interface CookieJar`
  A tiny cookie jar for in-process tests — parses `Set-Cookie` off responses and emits a `Cookie` request header, so a login → authenticated-request flow works without threading headers by hand. It honours removal (`Max-Age=0` / a past `Expires`) so logout clears the cookie; other attributes (Domain/…
- **FailureDirective** _(type)_ — `type FailureDirective`
- **FailureEvidence** _(interface)_ — `interface FailureEvidence`
- **FailureInjectedError** _(class)_ — `class FailureInjectedError`
- **FailureKind** _(type)_ — `type FailureKind = | "crash" | "duplicate-delivery" | "reorder-events" | "delay" | "expire-budget" | "lose-provider-reply" | "contend-checkpoint"`
  Deterministic durable-failure laboratory.
- **FailureLab** _(interface)_ — `interface FailureLab`
- **FailureLabOptions** _(interface)_ — `interface FailureLabOptions`
- **FailureReplay** _(interface)_ — `interface FailureReplay`
- **FailureScenario** _(interface)_ — `interface FailureScenario<Output>`
- **FailureScenarioReport** _(interface)_ — `interface FailureScenarioReport`
- **GenerateRegressionTestOptions** _(interface)_ — `interface GenerateRegressionTestOptions`
- **IncidentCapsule** _(interface)_ — `interface IncidentCapsule`
- **IncidentReplayError** _(class)_ — `class IncidentReplayError`
- **IncidentReplayResult** _(interface)_ — `interface IncidentReplayResult`
- **ReplayIncidentOptions** _(interface)_ — `interface ReplayIncidentOptions`
- **TestSession** _(interface)_ — `interface TestSession<App>`
- **TestSessionOptions** _(interface)_ — `interface TestSessionOptions`
- **assertAdapterCertification** _(function)_ — `assertAdapterCertification: (report: AdapterCertificationReport) => void`
- **assertAdversarialContract** _(function)_ — `assertAdversarialContract: (app: ContractTestApp, options?: AdversarialContractOptions) => Promise<AdversarialContractReport>`
  Run the contract laboratory and throw an {@link AdversarialContractError} unless it is fully green.
- **assertIncidentReplays** _(function)_ — `assertIncidentReplays: (app: AppLike, capsule: IncidentCapsule, options?: ReplayIncidentOptions) => Promise<void>`
  Assert a captured incident still reproduces against the current app. Throws {@link IncidentReplayError}.
- **cacheStoreCertificationProfile** _(function)_ — `cacheStoreCertificationProfile: () => AdapterCertificationProfile<CertifiableCacheStore>`
- **captureIncident** _(function)_ — `captureIncident: (request: Request | CapturedRequestInput, response: Response | { status: number; body?: unknown; }, options?: CaptureIncidentOptions) => Promise<IncidentCapsule>`
  Build a capsule from a real `Request`+`Response`, or from plain captured fields.
- **certifyAdapter** _(function)_ — `certifyAdapter: <Adapter>(options: { readonly profile: AdapterCertificationProfile<Adapter>; readonly adapterId: string; readonly createAdapter: () => Adapter | Promise<Adapter>; readonly cleanup?: (adapter: Adapter) =>…`
- **cookieJar** _(function)_ — `cookieJar: () => CookieJar`
  Create an empty cookie jar.
- **createFailureLab** _(function)_ — `createFailureLab: (options: FailureLabOptions) => FailureLab`
  Build one isolated deterministic controller. Construct a fresh lab for every replay.
- **defineCertificationProfile** _(function)_ — `defineCertificationProfile: <Adapter>(profile: AdapterCertificationProfile<Adapter>) => AdapterCertificationProfile<Adapter>`
  Define and validate a custom domain/provider profile at module initialization.
- **eventDeliveryCertificationProfile** _(function)_ — `eventDeliveryCertificationProfile: () => AdapterCertificationProfile<CertifiableEventDeliveryAdapter>`
- **generateRegressionTest** _(function)_ — `generateRegressionTest: (capsule: IncidentCapsule, options?: GenerateRegressionTestOptions) => string`
  Emit a committable regression test from a capsule. Request string values are redacted BY DEFAULT with a sanitize banner — replace the `<redacted>` placeholders with safe, reproducing values before you commit. The test asserts the response contract via {@link assertIncidentReplays}.
- **jobStoreCertificationProfile** _(function)_ — `jobStoreCertificationProfile: () => AdapterCertificationProfile<CertifiableJobStore>`
- **redactForEmission** _(function)_ — `redactForEmission: (value: unknown, allow: ReadonlySet<string>, path?: string) => unknown`
  Redact leaf string values by default (unless the dotted key path is allow-listed). Non-strings are kept — they carry the structure that makes the fixture reproduce — so review the emitted file. This is intentionally aggressive: a committed fixture must not leak PII/secrets.
- **replayIncident** _(function)_ — `replayIncident: (app: AppLike, capsule: IncidentCapsule, options?: ReplayIncidentOptions) => Promise<IncidentReplayResult>`
  Replay a captured incident against the current app and report whether it reproduces.
- **runAdversarialContract** _(function)_ — `runAdversarialContract: (app: ContractTestApp, options?: AdversarialContractOptions) => Promise<AdversarialContractReport>`
  Execute contract-derived hostile inputs and declared-response conformance against a runtime matrix. Runtime/request failures are captured in the report; inspect `report.ok`, `failures`, and `gaps` (or use {@link assertAdversarialContract} for a throwing test assertion).
- **runFailureScenario** _(function)_ — `runFailureScenario: <Output>(scenario: FailureScenario<Output>, options: FailureLabOptions) => Promise<FailureScenarioReport>`
  Run one scenario and evaluate its post-failure invariant without leaking its result or error text.
- **runtimeAdapterCertificationProfile** _(function)_ — `runtimeAdapterCertificationProfile: () => AdapterCertificationProfile<CertifiableRuntimeAdapter>`
- **shapeOf** _(function)_ — `shapeOf: (value: unknown) => unknown`
  A stable structural fingerprint: keys + value *types*, not values. Used for the optional shape check.
- **storageAdapterCertificationProfile** _(function)_ — `storageAdapterCertificationProfile: (options?: { readonly paging?: boolean; readonly presign?: boolean; readonly move?: boolean; }) => AdapterCertificationProfile<CertifiableStorageAdapter>`
- **testSession** _(function)_ — `testSession: <App extends AppLike>(app: App, options?: TestSessionOptions) => TestSession<App>`
  Create a cookie-persisting in-process test client for `app`.
- **verifyAdapterCertification** _(function)_ — `verifyAdapterCertification: (report: AdapterCertificationReport) => Promise<boolean>`
  Recompute the portable evidence hash. Consumers should verify before trusting a stored report.

### `@nifrajs/testing/certification`

- **AdapterCertificationError** _(class)_ — `class AdapterCertificationError`
- **AdapterCertificationProfile** _(interface)_ — `interface AdapterCertificationProfile<Adapter>`
- **AdapterCertificationReport** _(interface)_ — `interface AdapterCertificationReport`
- **CertifiableCacheEntry** _(interface)_ — `interface CertifiableCacheEntry`
- **CertifiableCacheStore** _(interface)_ — `interface CertifiableCacheStore`
- **CertifiableDomainEvent** _(interface)_ — `interface CertifiableDomainEvent`
- **CertifiableEventDeliveryAdapter** _(interface)_ — `interface CertifiableEventDeliveryAdapter`
- **CertifiableEventRecord** _(interface)_ — `interface CertifiableEventRecord`
- **CertifiableJobStore** _(interface)_ — `interface CertifiableJobStore`
- **CertifiableRuntimeAdapter** _(interface)_ — `interface CertifiableRuntimeAdapter`
- **CertifiableRuntimeServer** _(interface)_ — `interface CertifiableRuntimeServer`
- **CertifiableStorageAdapter** _(interface)_ — `interface CertifiableStorageAdapter`
- **CertifiableStorageObject** _(interface)_ — `interface CertifiableStorageObject`
- **CertifiableStoredJob** _(interface)_ — `interface CertifiableStoredJob`
- **CertificationCapabilityEvidence** _(interface)_ — `interface CertificationCapabilityEvidence`
- **CertificationCheck** _(interface)_ — `interface CertificationCheck<Adapter>`
- **CertificationCheckEvidence** _(interface)_ — `interface CertificationCheckEvidence`
- **CertificationContext** _(interface)_ — `interface CertificationContext`
  Profile-based adapter certification. Profiles are structural and dependency-free: an adapter package uses this only in its test/CI surface, while the resulting capability matrix is portable JSON evidence.
- **assertAdapterCertification** _(function)_ — `assertAdapterCertification: (report: AdapterCertificationReport) => void`
- **cacheStoreCertificationProfile** _(function)_ — `cacheStoreCertificationProfile: () => AdapterCertificationProfile<CertifiableCacheStore>`
- **certifyAdapter** _(function)_ — `certifyAdapter: <Adapter>(options: { readonly profile: AdapterCertificationProfile<Adapter>; readonly adapterId: string; readonly createAdapter: () => Adapter | Promise<Adapter>; readonly cleanup?: (adapter: Adapter) =>…`
- **defineCertificationProfile** _(function)_ — `defineCertificationProfile: <Adapter>(profile: AdapterCertificationProfile<Adapter>) => AdapterCertificationProfile<Adapter>`
  Define and validate a custom domain/provider profile at module initialization.
- **eventDeliveryCertificationProfile** _(function)_ — `eventDeliveryCertificationProfile: () => AdapterCertificationProfile<CertifiableEventDeliveryAdapter>`
- **jobStoreCertificationProfile** _(function)_ — `jobStoreCertificationProfile: () => AdapterCertificationProfile<CertifiableJobStore>`
- **runtimeAdapterCertificationProfile** _(function)_ — `runtimeAdapterCertificationProfile: () => AdapterCertificationProfile<CertifiableRuntimeAdapter>`
- **storageAdapterCertificationProfile** _(function)_ — `storageAdapterCertificationProfile: (options?: { readonly paging?: boolean; readonly presign?: boolean; readonly move?: boolean; }) => AdapterCertificationProfile<CertifiableStorageAdapter>`
- **verifyAdapterCertification** _(function)_ — `verifyAdapterCertification: (report: AdapterCertificationReport) => Promise<boolean>`
  Recompute the portable evidence hash. Consumers should verify before trusting a stored report.

## @nifrajs/uploads

- **FileType** _(interface)_ — `interface FileType`
  Magic-byte file-type detection — trust the bytes, not the `Content-Type` header (which a client sets freely). Reads only the leading bytes; dependency-free + edge-safe. Covers the common upload types; returns `null` for anything unrecognized (incl. text formats like SVG/CSV that have no magic numbe…
- **ImageReencoder** _(interface)_ — `interface ImageReencoder`
  The slice of `@nifrajs/image`'s `ImageBackend` this needs — `probe` for dims/format, `transform` to re-encode.
- **SignDownloadUrlOptions** _(interface)_ — `interface SignDownloadUrlOptions`
- **StripImageMetadataOptions** _(interface)_ — `interface StripImageMetadataOptions`
- **UploadResult** _(type)_ — `type UploadResult`
  Validate an upload's **size** and **real type** (by magic bytes, not the client's `Content-Type`). Pair with `c.boundedBody(maxBytes)` from `@nifrajs/core` to bound the *read* itself: read the body under the cap, then `validateUpload(bytes, …)` to confirm the size + sniff the type.
- **ValidateUploadOptions** _(interface)_ — `interface ValidateUploadOptions`
- **detectFileType** _(function)_ — `detectFileType: (bytes: Uint8Array) => FileType | null`
  Detect a file's type from its magic bytes, or `null` if unrecognized.
- **signDownloadUrl** _(function)_ — `signDownloadUrl: (url: string, secret: string, options: SignDownloadUrlOptions) => Promise<string>`
  Sign a relative URL/path → a relative URL with `?vexp=&vsig=` appended.
- **stripImageMetadata** _(function)_ — `stripImageMetadata: (bytes: Uint8Array, backend: ImageReencoder, options?: StripImageMetadataOptions) => Promise<Uint8Array>`
  Re-encode an image to its intrinsic size, dropping all embedded metadata. Returns clean bytes.
- **validateUpload** _(function)_ — `validateUpload: (input: Uint8Array | ArrayBuffer | Blob, options: ValidateUploadOptions) => Promise<UploadResult>`
  Validate uploaded bytes/Blob: size cap + magic-byte type sniff against an optional allow-list.
- **verifyDownloadUrl** _(function)_ — `verifyDownloadUrl: (url: string, secret: string, options?: { readonly now?: number; }) => Promise<boolean>`
  Verify a URL produced by {@link signDownloadUrl}: signature (constant-time) + not expired.

## @nifrajs/web

### `@nifrajs/web`

- **ACTION_GLOBAL** _(const)_ — `ACTION_GLOBAL: "__NIFRA_ACTION__"`
  Global the server serializes an action's data return into (absent on GETs); the client reads it so hydration after a native form POST matches the server-rendered markup.
- **Action** _(type)_ — `type Action = (ctx: LoaderContext) => unknown | Promise<unknown>`
  A route's optional mutation, run on POST. Shares the loader context (params/request/api); read the form/JSON body off `request`. Returns either a `Response` (e.g. a redirect — passed straight through) or data, surfaced to the page component as `actionData`.
- **BrowserNavigate** _(type)_ — `type BrowserNavigate = (to: string | number, options?: NavigateOptions) => void`
  A history-aware navigate. A **string** `to` is a same-origin path (`/users/7?tab=a`) navigated to (push, or replace with `{ replace: true }`); a **number** is a history delta (`-1` back, `1` forward), matching the browser's `history.go`. Registered by `installHistory`.
- **CacheStore** _(interface)_ — `interface CacheStore`
  Pluggable ISR cache backend. **Production deploys MUST use a shared/durable store** (Workers KV, Redis, the platform Cache API) so cached pages *and* revalidation hold across instances; {@link MemoryCacheStore} is dev / single-instance only. Implementations are async so a network store (KV/Redis) f…
- **CachedResponse** _(interface)_ — `interface CachedResponse`
  A cached SSR response — the bytes + metadata a {@link CacheStore} persists.
- **ClientRouter** _(interface)_ — `interface ClientRouter`
  The agnostic router store consumed by per-adapter Router bindings.
- **ClientRouterOptions** _(interface)_ — `interface ClientRouterOptions`
- **CreateWebAppOptions** _(interface)_ — `interface CreateWebAppOptions`
- **DATA_GLOBAL** _(const)_ — `DATA_GLOBAL: "__NIFRA_DATA__"`
  Global the server serializes loader data into; the client reads it to hydrate.
- **DATA_HEADER** _(const)_ — `DATA_HEADER: "x-nifra-data"`
  Request header that asks a nifra route's GET to return just the loader data as JSON (instead of the full HTML document). Set by client-side navigation; read by `createWebApp`'s GET handler.
- **DEFAULT_DEV_PORT** _(const)_ — `DEFAULT_DEV_PORT: 4321`
  The single default port for the dev server (`@nifrajs/web/dev`, `@nifrajs/web/vite`) **and** `nifra start`. Deliberately uncommon: `3000`/`5173`/`8080` collide with whatever else is running (Next, Vite, a stray Node API). `4321` rarely is — and being the *same* constant across `nifra dev` and `nifr…
- **DRAFT_COOKIE** _(const)_ — `DRAFT_COOKIE: "__nifra_draft"`
  The cookie name nifra uses for draft/preview mode.
- **Deferred** _(interface)_ — `interface Deferred<T>`
  A loader value marked to stream in after the shell. The component consumes it with the adapter's `<Await resolve={...}>`; until the promise settles the shell shows the `<Suspense>` fallback. `id` is assigned by the server at serialization time — the streamed resolve script keys off it.
- **DehydratedState** _(interface)_ — `interface DehydratedState`
  A serializable snapshot of the cache's successful queries — the SSR→client bridge payload.
- **DraftCookieControls** _(interface)_ — `interface DraftCookieControls`
  The response-cookie surface `enableDraft`/`disableDraft` need — nifra's `c.set`. Structural, so any nifra handler context satisfies it without importing the full `Context`.
- **EnableDraftOptions** _(interface)_ — `interface EnableDraftOptions`
- **FetchRouteData** _(type)_ — `type FetchRouteData = ( path: string, match: RouteMatch, signal?: AbortSignal, ) => Promise<unknown>`
  How a router fetches a route's loader data on navigation. `signal` aborts a superseded fetch (and its deferred stream).
- **Fetcher** _(interface)_ — `interface Fetcher`
  An independent load/submit state machine, retrieved by `router.fetcher(key)`. Runs **concurrently** with the main router and with other fetchers — each is single-flight against *itself* (its own monotonic token), so N row-level mutations / side-channel loads can be in flight at once without disturb…
- **FetcherState** _(interface)_ — `interface FetcherState`
  A fetcher's observable state — independent of the main router. `pending` covers its in-flight load/submit; `data` is its last `load()` result; `actionData` its last `submit()` result; `submission` the in-flight submit (for optimistic UI). Client-only (never SSR'd).
- **FontDisplay** _(type)_ — `type FontDisplay = "auto" | "block" | "swap" | "fallback" | "optional"`
  `font-display` strategy. `swap` (the default here) paints fallback text immediately, then swaps.
- **FontFace** _(interface)_ — `interface FontFace`
- **FontPreloadInput** _(interface)_ — `interface FontPreloadInput`
- **FontSource** _(interface)_ — `interface FontSource`
- **GenerateClientEntryOptions** _(interface)_ — `interface GenerateClientEntryOptions`
- **GenerateServerManifestOptions** _(interface)_ — `interface GenerateServerManifestOptions`
- **GetStaticPaths** _(type)_ — `type GetStaticPaths = () => StaticPaths | Promise<StaticPaths>`
  A dynamic route's build-time param enumeration (the SSG equivalent of "which pages exist").
- **ISRApp** _(interface)_ — `interface ISRApp`
  The app `withISR` wraps — anything with a `fetch(req, platform?)` (a `createWebApp` result).
- **ISROptions** _(interface)_ — `interface ISROptions`
- **ISRPlatform** _(interface)_ — `interface ISRPlatform`
  Minimal platform shape `withISR` needs — just `waitUntil` (edge runtimes extend the response lifetime so background regeneration finishes). Off-edge it's absent and regen runs fire-and-forget.
- **ISR_REVALIDATE_HEADER** _(const)_ — `ISR_REVALIDATE_HEADER: "x-nifra-isr-revalidate"`
  Response header a route uses to advertise its ISR freshness (**seconds**) to a {@link withISR} wrapper — `createWebApp` emits it from a route's `export const revalidate`. Deliberately distinct from the action-revalidation `x-nifra-revalidate` header (a CSV path list the *client* parses to refetch):…
- **ISR_STATUS_HEADER** _(const)_ — `ISR_STATUS_HEADER: "x-nifra-isr"`
  Response header marking how an ISR response was served: a cache `hit` (fresh), `stale` (served + regenerating behind it), or `miss` (rendered now + stored). Useful for debugging + tests.
- **InfiniteData** _(interface)_ — `interface InfiniteData<T, P>`
  An infinite (paged) query's accumulated data: the fetched `pages` in order + the `pageParam` each was fetched with (so the next/previous param can be derived).
- **InfiniteQueryHandle** _(interface)_ — `interface InfiniteQueryHandle<T, P>`
  A stable per-key handle for an infinite (paged) query.
- **InfiniteQueryOptions** _(interface)_ — `interface InfiniteQueryOptions<T, P>`
  Options for an {@link InfiniteQueryHandle}. `getNextPageParam` (required) derives the param for the next page from the last page — return `undefined`/`null` to signal there is no next page.
- **KVCacheStore** _(class)_ — `class KVCacheStore`
  A {@link CacheStore} backed by a **Cloudflare Workers KV** namespace (or any {@link KVNamespaceLike} binding) — the production-grade shared/durable store ISR wants: cached pages and on-demand purges hold *across* worker instances (unlike the per-instance {@link MemoryCacheStore}). Entries serialize…
- **KVCacheStoreOptions** _(interface)_ — `interface KVCacheStoreOptions`
- **KVNamespaceLike** _(interface)_ — `interface KVNamespaceLike`
  Minimal structural shape of a Cloudflare Workers **KV namespace** binding — just the three methods {@link KVCacheStore} uses. Structural (not a dependency on `@cloudflare/workers-types`) so any KV-like binding satisfies it and tests can pass an in-memory double.
- **LayoutEntry** _(interface)_ — `interface LayoutEntry`
  A layout (or `_404`/`_error`) entry: its source file (for client codegen) + a lazy loader.
- **LinkDescriptor** _(interface)_ — `interface LinkDescriptor`
  One `<link>` tag's attributes for a route/layout's `meta.link`. The common HTML `<link>` attributes are spelled out and **optional** so a typed partial like `{ rel, href, hreflang }` is assignable — the previous `Record<string, string>` required *every* value to be a present string, which rejected …
- **Loader** _(type)_ — `type Loader = (ctx: LoaderContext) => unknown | Promise<unknown>`
  A route's optional data loader: params/request in, data out.
- **LoaderContext** _(interface)_ — `interface LoaderContext`
  Context passed to a route `loader`. The `api` + `env` are injected by `createWebApp` and typed per-route via `@nifrajs/client`'s `LoaderArgs<Api, Env>` (here they are opaque to the agnostic core).
- **Manifest** _(interface)_ — `interface Manifest`
  The full route manifest.
- **MemoryCacheStore** _(class)_ — `class MemoryCacheStore`
  In-process ISR cache. Refuses to run in production unless explicitly allowed (mirrors the rate-limit `MemoryStore` — a per-instance cache is unsafe across instances). Bounded **LRU**: a read or write bumps the entry, so the least-recently-used evicts past `max` (a hot, frequently-read page survives…
- **MemoryCacheStoreOptions** _(interface)_ — `interface MemoryCacheStoreOptions`
- **Meta** _(interface)_ — `interface Meta`
  The document head a route contributes — title + `<meta>`/`<link>`/`<script>` tag sets. Returned by a route/layout `meta` (statically, or from a {@link MetaArgs} function). Every value is serialized into managed (`data-nifra`) head tags: attribute *names* are shape-validated and *values* HTML-escape…
- **MetaArgs** _(interface)_ — `interface MetaArgs<Data = unknown>`
  Args for a route's `meta` function: the loader's `data` + the route `params` + the request `origin`. `meta()` runs in BOTH SSR and client navigation, so it has **no `request`/`process.env`/server access** — `origin` is the only server-resolved fact it gets (so you needn't thread `siteUrl` through l…
- **MetaInput** _(type)_ — `type MetaInput = Meta | ((args: MetaArgs) => Meta)`
  A route's `meta`: a static {@link Meta}, or a function of the loader data + params + the request origin ({@link MetaArgs}). Use the `origin` arg for absolute `canonical`/`og:url`/`og:image` URLs — it's resolved server-side from the request and matches the client's `location.origin`.
- **MountRouterOptions** _(interface)_ — `interface MountRouterOptions`
  Options for a per-adapter `mountRouter` (the Router binding that hydrates + re-renders).
- **MutationCallbacks** _(interface)_ — `interface MutationCallbacks<TData, TVariables>`
  Lifecycle callbacks for a mutation. All optional; `onSettled` runs after success OR error.
- **MutationHandle** _(interface)_ — `interface MutationHandle<TData, TVariables>`
  A standalone mutation store: subscribe to its state, fire `mutate`, `reset` back to idle.
- **MutationState** _(interface)_ — `interface MutationState<TData, TVariables>`
  A mutation's observable state. A new (frozen) object per transition (reference-comparable).
- **MutationStatus** _(type)_ — `type MutationStatus = "idle" | "pending" | "success" | "error"`
  A mutation's lifecycle status.
- **NavigateOptions** _(interface)_ — `interface NavigateOptions`
  Options for a programmatic navigation.
- **OpenGraphInput** _(interface)_ — `interface OpenGraphInput`
  Inputs for {@link openGraph} — the common Open Graph properties. All optional; only the provided ones become tags. `type` defaults to `"website"`.
- **PRE_HYDRATION_GUARD** _(const)_ — `PRE_HYDRATION_GUARD: string`
  Pre-hydration form guard — a tiny inline script flushed in `<head>` (it runs in the window between first paint and the island bundle taking over). It neutralizes the one real hydration footgun: a JS-only form (a hand-wired `onSubmit` with no native fallback) submitting *natively* before its handler…
- **QueryClient** _(interface)_ — `interface QueryClient`
  The keyed query cache. One per app (a binding registers it like the router).
- **QueryClientOptions** _(interface)_ — `interface QueryClientOptions`
- **QueryHandle** _(interface)_ — `interface QueryHandle<T = unknown>`
  A stable per-key handle: subscribe to its state, read a snapshot, trigger a fetch/refetch.
- **QueryOptions** _(interface)_ — `interface QueryOptions`
  Per-query overrides passed alongside the fetcher.
- **QueryState** _(interface)_ — `interface QueryState<T = unknown>`
  A query's observable state — what a binding renders. A new (frozen) object per transition, so a `useSyncExternalStore`/signal binding can compare by reference.
- **QueryStatus** _(type)_ — `type QueryStatus = "pending" | "success" | "error"`
  A query's lifecycle status. `pending` = no data yet; `success`/`error` once it has settled once.
- **REDIRECT_HEADER** _(const)_ — `REDIRECT_HEADER: "x-nifra-redirect"`
  Response header a data-mode action POST uses to convey a redirect (`redirect(...)`) to the client — fetch would otherwise silently follow a 3xx to its HTML, losing the target. The client reads this and performs a client-side navigation instead.
- **REVALIDATE_HEADER** _(const)_ — `REVALIDATE_HEADER: "x-nifra-revalidate"`
  Response header an action sets (via the `revalidate(paths, data)` helper) to tell the client which routes the mutation changed — a comma-separated list of paths. After the submit, the client marks those cached routes stale (refetching any that are mounted) so a mutation can refresh views beyond the…
- **ROUTE_GLOBAL** _(const)_ — `ROUTE_GLOBAL: "__NIFRA_ROUTE__"`
  Global the server writes the matched route id into; the client uses it to pick the chain.
- **RedirectOptions** _(interface)_ — `interface RedirectOptions`
  Options for {@link redirect}.
- **RenderAdapter** _(interface)_ — `interface RenderAdapter`
  The seam every render adapter implements. New adapters should prove these invariants with {@link assertRenderAdapterConformance}; framework-specific behavior remains locally tested.
- **RenderAdapterConformanceError** _(class)_ — `class RenderAdapterConformanceError`
  A failed invariant reported by {@link assertRenderAdapterConformance}.
- **RenderAdapterConformanceFixture** _(interface)_ — `interface RenderAdapterConformanceFixture`
  Framework-specific values that let the shared conformance module exercise a render adapter.
- **RenderPageOptions** _(interface)_ — `interface RenderPageOptions`
- **RenderProps** _(interface)_ — `interface RenderProps`
  The data handed to a route component. Opaque to the core. `actionData` is the return of a route `action` after a POST (absent on plain GETs). `pending` + `submission` are client-only (absent on SSR): they drive **optimistic UI** — render from `submission.formData` while `pending`.
- **RenderedPage** _(interface)_ — `interface RenderedPage`
- **RevalidateEndpointOptions** _(interface)_ — `interface RevalidateEndpointOptions`
- **RevalidateResult** _(interface)_ — `interface RevalidateResult<T>`
  The wrapper `revalidate()` returns: the action's `data` plus the paths it changed. A plain tagged shape (not a class) so `@nifrajs/client`'s `ActionData` can unwrap it structurally without importing from `@nifrajs/web`. `createWebApp` strips the wrapper — the client receives `data` as the body and …
- **RouteEntry** _(interface)_ — `interface RouteEntry`
  One matched route: pattern, nested layout ids (outermost → innermost), source file, loader.
- **RouteMatch** _(interface)_ — `interface RouteMatch`
  A URL matched against the manifest patterns: which route + its extracted params.
- **RouteModule** _(interface)_ — `interface RouteModule`
  A route module — the default component + optional loader / action / meta.
- **RoutePattern** _(interface)_ — `interface RoutePattern`
  A route id paired with its nifra pattern (e.g. `":id"` segments) — the matcher input.
- **RouterState** _(interface)_ — `interface RouterState`
  The router's observable state. A new object is published on every transition.
- **ScriptDescriptor** _(interface)_ — `interface ScriptDescriptor`
  One `<script>` element a route contributes to `<head>` — for structured data (JSON-LD) and other inert, non-executable head scripts. The `content` is the script body; `type` defaults to `"application/ld+json"` (the common case). The renderer escapes `content` against an HTML breakout (`</`, `<!--`,…
- **ServerOnly** _(type)_ — `type ServerOnly<T> = T & { readonly [SERVER_ONLY_BRAND]?: never }`
  Type-level intent marker for a value that must only exist on the server — a secret, a DB handle, a server-only client. `ServerOnly<T>` is structurally `T` (the brand is an optional phantom field, so existing code keeps type-checking), but it advertises to readers + the compiler that the value is no…
- **StaticPath** _(interface)_ — `interface StaticPath`
  One concrete parameterization of a dynamic route, returned by {@link GetStaticPaths}.
- **StaticPaths** _(interface)_ — `interface StaticPaths`
  What a route's `getStaticPaths` returns: the param sets to prerender + the unlisted-path policy.
- **StaticRoutes** _(interface)_ — `interface StaticRoutes`
  The static-routing facts a server needs from the route modules: which concrete paths are prerendered, plus each dynamic route's `getStaticPaths` fallback policy.
- **Submission** _(interface)_ — `interface Submission`
  An in-flight client submit — the action it targets + the `FormData` being sent. Set while the submit is pending, cleared when it settles. A component reads `submission.formData` to render an **optimistic** view (the expected result) before the server responds.
- **SubmitOptions** _(interface)_ — `interface SubmitOptions`
  Per-submit options. `revalidate: false` opts out of the post-action loader re-fetch.
- **assertRenderAdapterConformance** _(function)_ — `assertRenderAdapterConformance: (adapter: RenderAdapter, fixture: RenderAdapterConformanceFixture) => Promise<void>`
  Execute the observable {@link RenderAdapter} interface against a framework-specific fixture.
- **buildManifest** _(function)_ — `buildManifest: (files: readonly string[], importer: (file: string) => () => Promise<RouteModule>) => Manifest`
  Build a manifest from route file paths (relative to the routes dir) + an `importer` that turns a path into a lazy module loader. Pure — no fs. Throws at boot (the loud-and-early RouteConfigError ethos) on duplicate patterns. `_layout`/`_404`/`_error` files are special; other `_`-prefixed files are …
- **canonical** _(function)_ — `canonical: (href: string) => LinkDescriptor`
  A `<link rel="canonical">` descriptor for a route's `meta.link`. The canonical URL tells search engines which URL is authoritative for a page (deduping query-string / tracking variants).
- **createClientRouter** _(function)_ — `createClientRouter: (options: ClientRouterOptions) => ClientRouter`
  Create the agnostic router store. `navigate` is guarded by a monotonic token so that when navigations overlap, only the latest result is applied (rapid clicks don't flash stale data). A failed fetch clears `pending` and rethrows so the caller can fall back to a full-page load.
- **createMatcher** _(function)_ — `createMatcher: (patterns: readonly RoutePattern[]) => (path: string) => RouteMatch | null`
  Build a matcher from route patterns (built from the SAME manifest the server routes from, so client and server agree). Returns the first matching route + decoded params, or null. The query string is ignored for matching (it is not part of the route pattern).
- **createMutation** _(function)_ — `createMutation: <TData, TVariables>(fn: (variables: TVariables) => Promise<TData>, callbacks?: MutationCallbacks<TData, TVariables>) => MutationHandle<TData, TVariables>`
  Create a standalone mutation state machine — framework-agnostic, so a per-adapter `useMutation` binding just subscribes to it. Single-flight by a monotonic token: overlapping `mutate` calls each run their `fn`, but only the latest publishes state (an older, slower response can't clobber a newer one…
- **createQueryClient** _(function)_ — `createQueryClient: (options: QueryClientOptions) => QueryClient`
- **createWebApp** _(function)_ — `createWebApp: <Env = unknown>(options: CreateWebAppOptions) => ReturnType<typeof server<Env>>`
  Build a nifra app from a route manifest: every route SSRs its layout chain via `renderPage`, and a wildcard catch-all renders `_404` (or a plain 404). Reuses
- **defer** _(function)_ — `defer: <T>(promise: Promise<T>) => Deferred<T>`
  Mark a loader value as deferred — it streams in after the shell instead of blocking it. Works **anywhere** in the loader's returned data — a top-level key, or nested in objects/arrays:
- **disableDraft** _(function)_ — `disableDraft: (c: { readonly set: DraftCookieControls; }, options?: { readonly path?: string; }) => void`
  Turn draft mode **off**: clear the `__nifra_draft` cookie. Match the `path` used in `enableDraft`.
- **enableDraft** _(function)_ — `enableDraft: (c: { readonly set: DraftCookieControls; }, secret: string, options?: EnableDraftOptions) => Promise<void>`
  Turn draft mode **on** for this client by setting a signed, HttpOnly `__nifra_draft` cookie. Call it from a route you've already authorized. `secret` signs the cookie — pass the SAME secret to `createWebApp({ draftSecret })` and `withISR({ draftSecret })` so the framework can verify it.
- **enumerateStaticRoutes** _(function)_ — `enumerateStaticRoutes: (routes: readonly RouteEntry[]) => Promise<StaticRoutes>`
  Enumerate the static-routing facts `prerenderRoutes` would produce — static routes opted in via `export const prerender = true`, each `getStaticPaths` entry of a dynamic route, and each dynamic route's `fallback` policy. Pure (no rendering), so a server can compute what to hand `createWebApp` (the …
- **filePathToPattern** _(function)_ — `filePathToPattern: (file: string) => string`
  The **canonical** single pattern for a route file — all optional segments present. A file with no optionals yields its one pattern. Use {@link filePathToPatterns} to get every pattern (optionals expand the set).
- **filePathToPatterns** _(function)_ — `filePathToPatterns: (file: string) => string[]`
  Derive **every** nifra router pattern a route file maps to (relative to the routes dir): `index` → the parent path, `[id]` → `:id`, `[...slug]` → `*slug` (catch-all, captures the rest of the path into one param), `(group)` folders are dropped from the URL (organization only), and an optional `[[lan…
- **fontFace** _(function)_ — `fontFace: (face: FontFace) => string`
  Build a single `@font-face` CSS rule. Defaults to `font-display: swap`; infers each source's `format()` from its extension. All values are CSS-escaped, so a dynamic family/URL can't inject CSS. Put the result in a stylesheet your app imports (nifra's CSS pipeline bundles + links it).
- **fontPreload** _(function)_ — `fontPreload: (input: FontPreloadInput) => LinkDescriptor`
  Build a font preload as a `<link>` attribute set for a route/layout's `meta.link` — nifra injects it into `<head>` (`<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous">`). Values are escaped at injection by the head renderer. Preloading the font file removes a render-blocking r…
- **generateClientEntry** _(function)_ — `generateClientEntry: (manifest: Manifest, options: GenerateClientEntryOptions) => string`
  Codegen: emit a client-entry module (as source) that lazily imports each route's layout chain (so `Bun.build` with `splitting` code-splits one chunk per route), builds a `patterns` list, then creates the agnostic router store (with a `loadModule` hook), installs history + form interception, loads t…
- **generateServerManifest** _(function)_ — `generateServerManifest: (manifest: Manifest, options: GenerateServerManifestOptions) => string`
  Codegen: emit a **server manifest** module (as source) for disk-less edge runtimes (Cloudflare Workers, …) — and, with a `target`, any portable server bundle. `discoverRoutes` scans `node:fs` and dynamic-imports each route by a *runtime* path — neither exists on workerd. This instead emits **static…
- **getBrowserNavigate** _(function)_ — `getBrowserNavigate: () => BrowserNavigate | undefined`
  The active browser navigate, or `undefined` on the server / before `installHistory` has run. A binding calls it when present and falls back to native navigation otherwise.
- **hashQueryKey** _(function)_ — `hashQueryKey: (key: unknown) => string`
  Hash a query key to a stable cache string. Object keys are sorted (so `{a,b}` ≡ `{b,a}`); arrays keep order. Keys must be serializable — a function/symbol in the key throws (it can't be a stable identity). Mirrors TanStack Query's structural hashing.
- **isDraftEnabled** _(function)_ — `isDraftEnabled: (request: Request, secret: string) => Promise<boolean>`
  Whether `request` carries a **valid** signed draft cookie (constant-time verify via `unsignValue`). `createWebApp` uses it to set `ctx.draft`; `withISR` uses it to bypass the cache for editors. A missing, forged, or tampered cookie returns `false`.
- **jsonLd** _(function)_ — `jsonLd: (data: Record<string, unknown>) => ScriptDescriptor`
  Build a JSON-LD `<script type="application/ld+json">` entry for a route's `meta.script` from a plain object. `JSON.stringify` produces the body; the head renderer breakout-escapes it (see `escapeScriptContent`), so a string field containing `</script>` is embedded safely.
- **mergeHeads** _(function)_ — `mergeHeads: (heads: readonly Meta[]) => Meta`
  Merge a route's `<head>` contributions from its layout chain + the page into one {@link Meta}.
- **openGraph** _(function)_ — `openGraph: (input: OpenGraphInput) => Array<Record<string, string>>`
  Build the Open Graph `<meta property="og:*">` entries for a route's `meta.meta`. Returns only the properties you supplied (plus `og:type`, defaulting to `"website"`), so it composes with other meta.
- **redirect** _(function)_ — `redirect: (location: string, options?: RedirectOptions) => Response`
  Build a redirect `Response` — return it from a route `action` for the Post/Redirect/Get pattern (POST mutates, 303 sends the browser to a fresh GET, so a reload doesn't re-submit). Defaults to 303 (See Other); pass `{ status: 307 }` or `{ status: 308 }` to preserve the method.
- **renderPage** _(function)_ — `renderPage: (options: RenderPageOptions) => MaybePromise<Response>`
  Server: render a full HTML document for a page — the adapter's hydration head + the SSR markup (**streamed**) + the serialized loader data + the client module — as a `Response`. The shell (`<head>` + the open container) flushes first, the adapter's app stream follows, then the tail (data globals + …
- **renderPageResult** _(function)_ — `renderPageResult: (options: RenderPageOptions) => MaybePromise<RenderedPage>`
- **resolveMeta** _(function)_ — `resolveMeta: (meta: MetaInput | undefined, args: MetaArgs) => Meta`
  Resolve a route's `meta` (static or a function of the loader data + params) to a {@link Meta}.
- **revalidate** _(function)_ — `revalidate: <T>(paths: readonly string[], data: T) => RevalidateResult<T>`
  Return this from an action to declare which routes the mutation changed (alongside the action's `data`). `createWebApp` sets the `X-Nifra-Revalidate` response header; after the submit the client marks those cached routes stale — refetching the active one and any mounted fetcher showing them — so a …
- **revalidateEndpoint** _(function)_ — `revalidateEndpoint: (options: RevalidateEndpointOptions) => (req: Request) => Promise<Response>`
  An **on-demand revalidation** (purge) endpoint — a `fetch` handler that drops a path's cached entry so the next request re-renders. `POST` with the secret in the token header and the path as `?path=` or a JSON `{ "path": "/blog/x" }` body. The token is checked in **constant time** (wrong/missing → …
- **serializeData** _(function)_ — `serializeData: (data: unknown) => string`
  Serialize loader data for embedding inside an inline `<script>`. `JSON.stringify` alone is NOT safe there: a string containing `</script>` or `<!--` would break out of the script element (an XSS vector). Escape `<`/`>` to `\uXXXX`, plus the U+2028/U+2029 separators.
- **setBrowserNavigate** _(function)_ — `setBrowserNavigate: (navigate: BrowserNavigate | undefined) => void`
  Register (or clear, with `undefined`) the browser navigate — called by `installHistory`. Not for app use.
- **withISR** _(function)_ — `withISR: (app: ISRApp, options: ISROptions) => (req: Request, platform?: ISRPlatform) => Promise<Response>`
  Wrap a nifra app with **Incremental Static Regeneration**: a cacheable page is served from {@link CacheStore} when fresh, served **stale while a fresh copy regenerates in the background** (`platform.waitUntil` on edge), or rendered + stored on a miss. Framework-agnostic (it caches the rendered byte…

### `@nifrajs/web/build`

- **BUILD_TARGETS** _(const)_ — `BUILD_TARGETS: readonly ["bun", "node", "deno", "cf-pages", "vercel", "static"]`
  A deploy target `nifra build --target <t>` can emit. `static` is pure SSG (no server).
- **BuildClientOptions** _(interface)_ — `interface BuildClientOptions`
- **BuildManifest** _(interface)_ — `interface BuildManifest`
  The built asset map — the server reads `entry` for the client script + serves `assets`.
- **BuildServerOptions** _(interface)_ — `interface BuildServerOptions`
- **BuildTarget** _(type)_ — `type BuildTarget = (typeof BUILD_TARGETS)[number]`
- **BuildTargetOptions** _(interface)_ — `interface BuildTargetOptions`
- **BuildTargetResult** _(interface)_ — `interface BuildTargetResult`
  The result of a target build — the deploy dir + the client manifest + an optional size report.
- **ChunkSize** _(interface)_ — `interface ChunkSize`
  One emitted chunk's measured size, in raw bytes + gzipped bytes (over-the-wire weight).
- **CloudflarePagesRoutes** _(interface)_ — `interface CloudflarePagesRoutes`
  A Cloudflare Pages `_routes.json` document. `exclude`d paths are served straight from the CDN (the Function/worker is NOT invoked); everything else in `include` hits the worker.
- **CloudflarePagesRoutesOptions** _(interface)_ — `interface CloudflarePagesRoutesOptions`
- **ManifestDrift** _(interface)_ — `interface ManifestDrift`
  A drift finding between a committed server-manifest and the live `routes/` tree.
- **NodeBuiltinFinding** _(interface)_ — `interface NodeBuiltinFinding`
  One `node:`-builtin-in-the-client finding: the offending builtin, the emitted chunk it landed in, and the shortest USER-module import chain that pulled it there (entry → … → builtin).
- **PrerenderApp** _(interface)_ — `interface PrerenderApp`
  Minimal app surface the driver needs — just a fetch handler (a built `createWebApp`).
- **PrerenderAppLike** _(interface)_ — `interface PrerenderAppLike`
  Minimal app surface `buildTarget`'s static path needs — a fetch handler (a built `createWebApp`).
- **PrerenderEntry** _(interface)_ — `interface PrerenderEntry`
- **PrerenderOptions** _(interface)_ — `interface PrerenderOptions`
- **PrerenderResult** _(interface)_ — `interface PrerenderResult`
- **SERVER_ONLY_MARKER** _(const)_ — `SERVER_ONLY_MARKER: "@nifrajs/web/server-only"`
  The marker specifier an author imports to opt a module into the client-leak guard. Matched on the import edge's *as-written* `original` first (the robust signal: it's exactly what the author typed, before Bun resolves it to `src/server-only.ts` / `dist/server-only.js`).
- **ServerBuild** _(interface)_ — `interface ServerBuild`
  The built worker bundle — point your `wrangler.toml`'s `main` at `worker`.
- **ServerOnlyFinding** _(interface)_ — `interface ServerOnlyFinding`
  One `server-only`-module-in-the-client finding: the offending module (the as-written marker-import chain's tail before the marker), the emitted chunk it landed in, and the shortest USER-module import chain that pulled it there (entry → … → the server-only module).
- **SizeReport** _(interface)_ — `interface SizeReport`
  A whole build's size report — every chunk (largest first) + the totals.
- **aggregateSizeReport** _(function)_ — `aggregateSizeReport: (chunks: readonly ChunkSize[]) => SizeReport`
  Aggregate a list of measured chunks into a {@link SizeReport}: sort biggest-gzip-first (ties broken by raw bytes, then name for stable output) and sum the totals. Pure — the measurement (reading the file + `Bun.gzipSync`) happens in the orchestrator; this is the deterministic, unit-testable core.
- **buildClient** _(function)_ — `buildClient: (options: BuildClientOptions) => Promise<BuildManifest>`
  Build the client bundle for a file-routed app. Writes the hashed assets + `manifest.json` to `outDir` and returns the manifest. Throws (with the bundler logs) on build failure — never silently ships a broken bundle.
- **buildServer** _(function)_ — `buildServer: (options: BuildServerOptions) => Promise<ServerBuild>`
  Build a self-contained **worker bundle** for a file-routed app on a disk-less edge (Cloudflare Workers / workerd). Discovers routes (build-time fs), codegens the static-import server manifest (`generateServerManifest`, written next to `serverEntry`), then bundles `serverEntry` with `Bun.build` usin…
- **buildTarget** _(function)_ — `buildTarget: (target: BuildTarget, options: BuildTargetOptions) => Promise<BuildTargetResult>`
  Build a full deploy directory for `target` from a file-routed nifra app. Emits the client bundle to `<outDir>/assets/*`, then per target: - `static`: prerenders opted-in routes (`prerenderRoutes`) to `<outDir>/<path>/index.html` (+ `_data.json`); needs `prerenderApp`. No server. - `cf-pages`: a `_w…
- **cloudflarePagesRoutes** _(function)_ — `cloudflarePagesRoutes: (options: CloudflarePagesRoutesOptions) => CloudflarePagesRoutes`
  Build a Cloudflare Pages `_routes.json` for a HYBRID SSG deploy: the prerendered HTML + their static `_data.json` + the asset bundle are `exclude`d (CDN serves them directly), and everything else falls through to the SSR `_worker.js`. Write the result to `dist/_routes.json`.
- **dataFileFor** _(function)_ — `dataFileFor: (pattern: string) => string`
  The static loader-data file next to a route's `index.html`: `/` → `_data.json`, `/a/b` → `a/b/_data.json`. The client fetches it on soft-nav into a prerendered route (no worker).
- **detectNodeBuiltinsInClient** _(function)_ — `detectNodeBuiltinsInClient: (meta: BunMetafile | undefined) => ReadonlyArray<NodeBuiltinFinding>`
  Scan a build's metafile for any `node:` builtin that a USER module pulled into a CLIENT output chunk, returning a sorted, deduped list of {@link NodeBuiltinFinding}s. Three graph facts combine so the report is precise AND actionable: 1. **What the user wrote** — only builtins imported by a NON-`nod…
- **detectServerOnlyInClient** _(function)_ — `detectServerOnlyInClient: (meta: BunMetafile | undefined) => ReadonlyArray<ServerOnlyFinding>`
  Scan a build's metafile for any module that opts into the `server-only` marker (a side-effect `import "@nifrajs/web/server-only"`) yet landed in a CLIENT output chunk, returning a sorted, deduped list of {@link ServerOnlyFinding}s. Mirrors {@link detectNodeBuiltinsInClient}: it reads the SAME graph…
- **diffManifestRoutes** _(function)_ — `diffManifestRoutes: (manifestFiles: readonly string[], discoveredFiles: readonly string[]) => ManifestDrift`
  Diff the route files a committed server-manifest imports against the files freshly discovered in `routes/`. Returns the `missing` (in routes/, not in manifest — stale manifest) and `extra` (in manifest, gone from routes/ — dangling import) sets. Empty arrays ⇒ in sync. Pure — the caller supplies bo…
- **formatBytes** _(function)_ — `formatBytes: (bytes: number) => string`
  Human-readable byte count: `B`/`KB`/`MB` with one decimal above 1 KB (e.g. `12.3 KB`). Pure.
- **formatManifestDrift** _(function)_ — `formatManifestDrift: (drift: ManifestDrift, manifestPath?: string) => string | undefined`
  Format a {@link ManifestDrift} as a named, actionable error message, or `undefined` when in sync. Names the exact missing/extra routes + the one fix (regenerate the manifest by re-running the build). `manifestPath` is shown for the dev to locate the stale file. Pure.
- **generateServerEntry** _(function)_ — `generateServerEntry: (options: { readonly target: BuildTarget; readonly adapterImport: string; readonly backendImport?: string; readonly title?: string; }) => string`
  Codegen the per-target **server entry** module (source text) for `buildServer` to bundle. It imports the app's `adapter` (from `framework.ts`), the optional `backend` (from `backend.ts`), and the generated `{ manifest, clientEntry }` (from `./server-manifest`), builds `createWebApp`, then wires the…
- **htmlFileFor** _(function)_ — `htmlFileFor: (pattern: string) => string`
  Map a route path to its output file: `/` → `index.html`, `/a/b` → `a/b/index.html`.
- **isBuildTarget** _(function)_ — `isBuildTarget: (value: string) => value is BuildTarget`
  A type guard narrowing an arbitrary string to a {@link BuildTarget}.
- **isManifestInSync** _(function)_ — `isManifestInSync: (drift: ManifestDrift) => boolean`
  True when a drift report is clean (no missing + no extra routes).
- **parseManifestClientEntry** _(function)_ — `parseManifestClientEntry: (source: string) => string | undefined`
  The baked `clientEntry` URL in a committed server-manifest, or `undefined` if absent. Pure.
- **parseManifestRouteFiles** _(function)_ — `parseManifestRouteFiles: (source: string, routesPrefix?: string) => string[]`
  Extract the route-relative file list the committed server-manifest imports, normalized to the same `routes/`-relative keys `discoverRoutes` produces (e.g. `docs/index.tsx`). `routesPrefix` is the specifier prefix the manifest used for the routes dir (default `./routes/`, what `buildServer`'s defaul…
- **parseManifestRouteStyles** _(function)_ — `parseManifestRouteStyles: (source: string) => Record<string, string[]>`
  The baked per-route `routeStyles` map in a committed server-manifest (empty if absent/unparseable). Pure.
- **parseManifestStyles** _(function)_ — `parseManifestStyles: (source: string) => string[]`
  The baked top-level `styles` array in a committed server-manifest (empty if absent/unparseable). Pure.
- **preactDedupePlugin** _(const)_ — `preactDedupePlugin: (from: string) => BunPlugin`
- **prerenderRoutes** _(function)_ — `prerenderRoutes: (options: PrerenderOptions) => Promise<PrerenderResult>`
  Render every opted-in static route to a static `index.html` under `outDir`. Run AFTER `buildClient` (so the app references the hashed client entry). Returns a report of what was emitted vs skipped — the caller can use `prerendered` to wire a hybrid deploy (e.g. exclude those paths from the SSR work…
- **publicEnvDefines** _(function)_ — `publicEnvDefines: (prefix: string, env: Readonly<Record<string, string | undefined>>) => Record<string, string>`
  The `process.env.<NAME>` → `JSON.stringify(value)` define entries for every env var whose name carries `prefix` (the Vite/Next public-env convention). Exposing ONLY the prefixed vars is the security boundary: an unprefixed var (a secret) never gets a define, so the bare `process.env` define resolve…
- **reactDedupePlugin** _(const)_ — `reactDedupePlugin: (from: string) => BunPlugin`
- **renderSizeReport** _(function)_ — `renderSizeReport: (report: SizeReport) => string`
  Render a {@link SizeReport} as a terse aligned table (biggest first) with a totals row — the text `nifra build --report` prints. Pure (string in, string out) so the formatting is unit-testable.
- **resyncServerManifestSource** _(function)_ — `resyncServerManifestSource: (source: string, manifest: Parameters<typeof generateServerManifest>[0], routesPrefix: string) => string`
  Re-emit a committed server-manifest from a freshly-discovered route tree, PRESERVING its baked client-asset references (`clientEntry` / `styles` / `routeStyles`) and its eager-vs-lazy shape. This is what makes `nifra sync-manifest` a route-table refresh (renamed / added / removed routes) that does …
- **serverOnlyEmptyPlugin** _(const)_ — `serverOnlyEmptyPlugin: () => BunPlugin`
- **svelteDedupePlugin** _(const)_ — `svelteDedupePlugin: (from: string) => BunPlugin`
  Dedupe Svelte to a single copy — the Svelte analogue of `reactDedupePlugin`/`preactDedupePlugin`, closing the same class of bug for Svelte (which had NO build-time dedup before). A workspace- or file-linked `@nifrajs/web-svelte` can resolve its OWN `svelte` (e.g. a sibling repo's install store) whi…

### `@nifrajs/web/client`

- **InstallHistoryOptions** _(interface)_ — `interface InstallHistoryOptions`
- **applyHead** _(function)_ — `applyHead: (head: Meta) => void`
  Sync the document head to a route's resolved {@link Meta} on client navigation. Sets the title (when provided) and replaces the **managed** (`data-nifra`) `<meta>`/`<link>` tags — static head content (charset, hand-written tags) is never touched. SSR injects the same `data-nifra` tags, so the first…
- **installForms** _(function)_ — `installForms: (router: ClientRouter) => () => void`
- **installHistory** _(function)_ — `installHistory: (router: ClientRouter, options?: InstallHistoryOptions) => () => void`
  Attach history + link interception to a router. Returns a teardown function that removes the listeners. A data-fetch failure during a client navigation falls back to a full-page load, so navigation degrades gracefully rather than leaving the user stuck.
- **signalHydrated** _(function)_ — `signalHydrated: () => void`
  Mark the document interactive once the client has hydrated: sets `data-nifra-hydrated` on `<html>` and fires a one-shot `nifra:hydrated` event. The generated client entry calls this on the next frame after the adapter mounts (so every framework binding gets it), letting apps gate a custom JS-only i…

### `@nifrajs/web/conformance`

- **RenderAdapterConformanceError** _(class)_ — `class RenderAdapterConformanceError`
  A failed invariant reported by {@link assertRenderAdapterConformance}.
- **RenderAdapterConformanceFixture** _(interface)_ — `interface RenderAdapterConformanceFixture`
  Framework-specific values that let the shared conformance module exercise a render adapter.
- **assertRenderAdapterConformance** _(function)_ — `assertRenderAdapterConformance: (adapter: RenderAdapter, fixture: RenderAdapterConformanceFixture) => Promise<void>`
  Execute the observable {@link RenderAdapter} interface against a framework-specific fixture.

### `@nifrajs/web/dev`

- **DevServer** _(interface)_ — `interface DevServer`
- **DevServerOptions** _(interface)_ — `interface DevServerOptions`
- **createDevServer** _(function)_ — `createDevServer: (options: DevServerOptions) => Promise<DevServer>`
  Start the dev server: build → serve → watch → rebuild + reload on change.

### `@nifrajs/web/fonts`

- **FontAsset** _(interface)_ — `interface FontAsset`
  One downloaded + written font file.
- **GoogleFontOptions** _(interface)_ — `interface GoogleFontOptions`
  Options describing the Google font to fetch + self-host.
- **LoadGoogleFontIO** _(interface)_ — `interface LoadGoogleFontIO`
- **LoadGoogleFontResult** _(interface)_ — `interface LoadGoogleFontResult`
- **ParsedFontFace** _(interface)_ — `interface ParsedFontFace`
  A single `@font-face` block parsed out of Google's stylesheet.
- **googleFontsCssUrl** _(function)_ — `googleFontsCssUrl: (options: GoogleFontOptions) => string`
  Build the Google Fonts CSS2 request URL. Pure + fully validated, so it's safe to feed a dynamic family/weights/text. Exported for advanced callers who fetch + parse the stylesheet themselves.
- **isAllowedFontUrl** _(function)_ — `isAllowedFontUrl: (raw: string) => boolean`
  `true` iff `raw` is an `https://fonts.gstatic.com/…` URL — the only host we'll download from.
- **loadGoogleFont** _(function)_ — `loadGoogleFont: (options: GoogleFontOptions, io: LoadGoogleFontIO) => Promise<LoadGoogleFontResult>`
  Download a Google font, self-host it, and return a CLS-safe `@font-face` stylesheet + preloads. See the module header for the full flow and security model. I/O (`fetch`, `writeFile`) is injectable so this is unit-testable without the network.
- **parseGoogleFontCss** _(function)_ — `parseGoogleFontCss: (css: string) => ParsedFontFace[]`
  Parse Google's stylesheet into structured faces, capturing the `/* subset *​/` label that precedes each `@font-face`. Pure — exported so callers can run their own download/write pipeline.

### `@nifrajs/web/forms`

- **FieldKey** _(type)_ — `type FieldKey<App, Path extends string, Method extends string> = [ RouteBody<App, Path, Method>, ] extends [never] ? never : keyof RouteBody<App, Path, Method> & string`
  The valid field names for that route's body — the schema's keys as a string union.
- **FieldProps** _(type)_ — `type FieldProps = Record<string, unknown>`
  Extra attributes merged into the returned input props (id, type, defaultValue, placeholder, …).
- **FormHandle** _(interface)_ — `interface FormHandle<App, Path extends string, Method extends string>`
- **RouteBody** _(type)_ — `type RouteBody<App, Path extends string, Method extends string> = Path extends keyof RegistryOf<App> ? Uppercase<Method> extends keyof RegistryOf<App>[Path] ? (RegistryOf<App>[Path][Uppercase<Method>] & RouteInfo)["body…`
  The body object type of `App`'s `Method Path` route (`never` when the route declares no body).
- **RoutePaths** _(type)_ — `type RoutePaths<App> = keyof RegistryOf<App> & string`
  Every route path the app declares — constrains `Path`, so a wrong path is itself a type error.
- **formFor** _(function)_ — `formFor: <App, Path extends RoutePaths<App>, Method extends string = "post">() => FormHandle<App, Path, Method>`
  Bind a form to a backend route's body schema at the type level. `App` is `typeof backend`; `Path` is constrained to the app's real routes (a wrong path is a type error); `Method` defaults to `"post"`.

### `@nifrajs/web/fs`

- **DiscoverRoutesOptions** _(interface)_ — `interface DiscoverRoutesOptions`
  Options for {@link discoverRoutes}.
- **discoverRoutes** _(function)_ — `discoverRoutes: (dir: string, options?: DiscoverRoutesOptions) => Manifest`
  Scan a `routes/` directory (recursively) and build the route manifest.

### `@nifrajs/web/islands`

- **IslandCleanup** _(type)_ — `type IslandCleanup = () => void`
  Optional teardown an enhancer returns (remove listeners/observers); run on `dispose()`.
- **IslandEnhancer** _(type)_ — `type IslandEnhancer<P = unknown> = (el: HTMLElement, props: P) => IslandCleanup | void`
  Enhances one island element with its (typed) props. Return a cleanup function to tear down on `dispose()` (listeners, observers) — optional; an enhancer with nothing to clean up returns nothing. The `void` member is the no-cleanup case, the same shape as React's `EffectCallback`.
- **IslandStrategy** _(type)_ — `type IslandStrategy = "load" | "idle" | "visible"`
  When an island's enhancer runs. Default `load`.
- **mountIslands** _(function)_ — `mountIslands: (enhancers: Readonly<Record<string, IslandEnhancer>>, options?: { readonly root?: ParentNode; }) => () => void`
  Find every `<nifra-island data-id>` under `root` (default `document`) and enhance each with the matching enhancer, honoring its `data-strategy`. An island whose `id` has no enhancer is left as inert SSR HTML (forward-compatible). An enhancer that throws is isolated — it never blocks the others (eac…

### `@nifrajs/web/plugins/css-modules`

- **CssModuleResult** _(interface)_ — `interface CssModuleResult`
  The transform result: the `{ original: scoped }` export map + the rewritten (scoped) stylesheet.
- **cssModulesBunPlugin** _(function)_ — `cssModulesBunPlugin: (generate: "dom" | "ssr") => BunPlugin`
  The CSS Modules Bun plugin. `"dom"` → the `.module.css` import becomes the class map AND emits the scoped stylesheet as a virtual `?nifra-css-module` module that `Bun.build`'s CSS bundler folds into the app stylesheet. `"ssr"` → the class map only (no CSS; the scoped names match the client build). …
- **transformCssModule** _(function)_ — `transformCssModule: (source: string, filePath: string) => CssModuleResult`
  Pure core (no I/O): scope a CSS-module source. Same `(source, filePath)` in → byte-identical out, so the `"dom"` and `"ssr"` plugin forms produce the same class map. Exposed for direct testing.

### `@nifrajs/web/plugins/kit`

- **PluginBuilder** _(type)_ — `type PluginBuilder = Parameters<BunPlugin["setup"]>[0]`
  The argument Bun passes to a plugin's `setup` — Bun doesn't export the type, so derive it.
- **StylesheetEmitter** _(interface)_ — `interface StylesheetEmitter`
  Records compiled CSS and wires it into the client bundle through a virtual `?<namespace>` module — the idiom the Vue plugin established (`?vue-css`). Register one per plugin `setup`; call `emit` per file to stash its CSS and get back the `import` line to append to the JS module.
- **createStylesheetEmitter** _(function)_ — `createStylesheetEmitter: (build: PluginBuilder, namespace: string) => StylesheetEmitter`
  Wire the virtual-CSS-module handlers onto `build` for `namespace`, returning an {@link StylesheetEmitter}. The `namespace` must be a plain identifier (letters/`-`); it's used verbatim as the import suffix and the Bun namespace. Only the `"dom"` build should emit CSS — the `"ssr"` build ships no sty…
- **hash8** _(function)_ — `hash8: (input: string) => string`
  Deterministic 8-hex hash (djb2/xor). Stable across builds — no `Date.now`/`Math.random` — so build output is reproducible. The single hash implementation behind CSS-module scoped names (and a drop-in for any SFC scope id).
- **reproduciblePath** _(function)_ — `reproduciblePath: (absolutePath: string) => string`
  A **package-root-relative**, forward-slashed form of an absolute path — the input to {@link hash8} for any build-stable identifier (e.g. CSS-module scoped names). Anchoring on the file's nearest `package.json` (not the absolute path, not `process.cwd()`) makes the result independent of BOTH the mac…
- **requirePeer** _(function)_ — `requirePeer: <T>(specifier: string, hint: { readonly feature: string; readonly install: string; }) => Promise<T>`
  Load an optional peer compiler at build time, throwing a consistent, actionable install-hint error if it's absent — the `@vue/compiler-sfc` peer pattern, centralized. Build-time only, so the dynamic `import` (which keeps the peer out of the package's hard dependencies) is correct here.

### `@nifrajs/web/plugins/postcss`

- **PostcssConfigLoader** _(type)_ — `type PostcssConfigLoader = ( ctx?: Record<string, unknown>, path?: string, ) => Promise<{ readonly plugins?: readonly unknown[]; readonly options?: Record<string, unknown> }>`
  The subset of `postcss-load-config` this plugin uses when no explicit `plugins` are given.
- **PostcssPluginOptions** _(interface)_ — `interface PostcssPluginOptions`
- **PostcssProcessor** _(type)_ — `type PostcssProcessor = (plugins?: readonly unknown[]) => { process( css: string, options: { readonly from?: string; readonly to?: string }, ): PromiseLike<{ readonly css: string }> }`
  The subset of the `postcss` API this plugin uses (structural, so no hard dependency on its types).
- **postcssBunPlugin** _(function)_ — `postcssBunPlugin: (generate: "dom" | "ssr", options?: PostcssPluginOptions) => BunPlugin`
  The PostCSS Bun plugin. `"dom"` → bundles the processed CSS (and, for `*.module.*`, exports the scoped class map); `"ssr"` → the class map only for `*.module.*`, an empty module for plain CSS. Tolerates a trailing `?query` (dev servers append one to bust Bun's import cache).

### `@nifrajs/web/plugins/scss`

- **SassCompiler** _(interface)_ — `interface SassCompiler`
  The subset of the `sass` / `sass-embedded` API this plugin uses. Both packages satisfy it.
- **ScssPluginOptions** _(interface)_ — `interface ScssPluginOptions`
- **scssBunPlugin** _(function)_ — `scssBunPlugin: (generate: "dom" | "ssr", options?: ScssPluginOptions) => BunPlugin`
  The SASS/SCSS Bun plugin. `"dom"` → bundles the compiled CSS (and, for `*.module.scss`, exports the scoped class map); `"ssr"` → the class map only for `*.module.scss`, an empty module for plain Sass. Tolerates a trailing `?query` (dev servers append one to bust Bun's import cache).

### `@nifrajs/web/plugins/svg`

- **SVG_COMPONENT_FILTER** _(const)_ — `SVG_COMPONENT_FILTER: RegExp`
  The Bun `onLoad` filter every adapter's SVG-component plugin matches: `*.svg?component`.
- **SvgOptimizer** _(interface)_ — `interface SvgOptimizer`
  The subset of the `svgo` API this plugin uses (structural, so no hard dependency on its types).
- **SvgPluginOptions** _(interface)_ — `interface SvgPluginOptions`
- **SvgToJsxOptions** _(interface)_ — `interface SvgToJsxOptions`
- **svgComponentBunPlugin** _(function)_ — `svgComponentBunPlugin: (_generate: "dom" | "ssr", options?: SvgPluginOptions) => BunPlugin`
  The SVG-as-component Bun plugin (React/Preact). `generate` is accepted for parity with the other plugin pairs; the emitted component is the same on `"dom"` and `"ssr"`.
- **svgComponentSource** _(function)_ — `svgComponentSource: (xml: string, options?: SvgToJsxOptions) => string`
  Emit the component module source for a `?component` SVG import. Identical on dom + ssr (isomorphic).
- **svgToJsx** _(function)_ — `svgToJsx: (xml: string, options?: SvgToJsxOptions) => string`
  Convert an SVG XML string into a JSX-safe `<svg>…</svg>` element with `{...props}` spread on the root.

### `@nifrajs/web/server-only`

_No named exports (side-effect entrypoint)._

### `@nifrajs/web/vite`

- **ViteDevServer** _(interface)_ — `interface ViteDevServer`
- **ViteDevServerOptions** _(interface)_ — `interface ViteDevServerOptions`
- **applyResponseHeaders** _(function)_ — `applyResponseHeaders: (headers: Headers, res: NodeHeaderSink) => void`
  Copy a Web `Response`'s headers onto a Node response, emitting EACH `Set-Cookie` as its own header. The `Headers` iterator (and `.get`) join multiple set-cookie values with ", ", which corrupts cookies — e.g. better-auth's `session_token` + `session_data` collapse into one unparseable cookie and th…
- **createViteDevServer** _(function)_ — `createViteDevServer: (options: ViteDevServerOptions) => Promise<ViteDevServer>`
  Start the Vite-backed dev server: Vite serves/HMRs the client; nifra SSRs each request and Vite injects its HMR client + the framework refresh preamble via `transformIndexHtml`.
- **normalizeRolldownPlugins** _(function)_ — `normalizeRolldownPlugins: (plugins: readonly unknown[], isRolldown: boolean) => readonly unknown[]`
  Strip `optimizeDeps.rollupOptions.jsx` from a plugin's `config` hook output when running under rolldown-vite — the source of the scary, harmless `Warning: Invalid input options … "jsx" Invalid key: Expected never but received "jsx"` on `nifra dev`.
- **pipeWebBodyToNode** _(function)_ — `pipeWebBodyToNode: (body: ReadableStream<Uint8Array> | null, res: NodeResLike) => Promise<void>`
  Stream a Web `Response` body to a Node response chunk-by-chunk. Buffering the whole body (e.g. `arrayBuffer()`) waits for the stream to END — which an open-ended SSE (`text/event-stream`) body never does, so it hung `nifra dev` (the Bun production server streamed it fine). This flushes each chunk a…

## @nifrajs/web-preact

### `@nifrajs/web-preact`

- **preactAdapter** _(const)_ — `preactAdapter: RenderAdapter`
  The Preact server render adapter — pass to

### `@nifrajs/web-preact/await`

- **Await** _(function)_ — `Await: <T>(props: AwaitProps<T>) => VNode | ComponentChildren`
  Render deferred loader data: show `fallback` until the `Deferred` settles (streamed in by the server), then `children(value)`. An already-resolved `resolve` (a client navigation awaited it) renders immediately. Pairs with a loader's `defer(...)`.
- **AwaitProps** _(interface)_ — `interface AwaitProps<T>`

### `@nifrajs/web-preact/client`

- **errorBoundary** _(function)_ — `errorBoundary: (fallback: unknown) => unknown`
  Build an error-boundary chain element bound to `fallback` (a route's `_error` component). nifra's client codegen inserts it before the page in the matched chain; a render error in the subtree renders `fallback` with `{ data: { name, message } }` instead of crashing the app. DOM-transparent (it rend…
- **hydrate** _(function)_ — `hydrate: (chain: readonly unknown[], props: RenderProps, container: unknown) => void`
  Hydrate a server-rendered Preact layout `chain` (with the loader `props`) inside `container`.
- **mountRouter** _(function)_ — `mountRouter: (options: MountRouterOptions) => void`
  Hydrate a stateful Preact Router. `useSyncExternalStore` (preact/compat) subscribes to the agnostic store and re-renders the matched layout chain on each store change — so client navigations swap routes without a full reload. Preact's compat `useSyncExternalStore` is 2-arg (no `getServerSnapshot`);…

### `@nifrajs/web-preact/content`

- **Content** _(function)_ — `Content: ({ html, as, ...rest }: ContentProps) => VNode`
  Render trusted HTML into a wrapper element. Extra props (`class`, `id`, `style`, …) pass through.
- **ContentProps** _(interface)_ — `interface ContentProps`

### `@nifrajs/web-preact/fetcher`

- **FetcherHandle** _(interface)_ — `interface FetcherHandle`
  A fetcher's reactive {@link FetcherState} plus its imperative `load`/`submit`.
- **setMountedRouter** _(function)_ — `setMountedRouter: (router: ClientRouter | undefined) => void`
  Register (or clear) the router that owns fetchers — called by `mountRouter`. Not for app use.
- **useFetcher** _(function)_ — `useFetcher: (key: string) => FetcherHandle`
  Subscribe to the independent fetcher for `key` (created lazily, stable across renders). Returns its state (`pending`/`data`/`actionData`/`submission`) + `load`/`submit`. Multiple `useFetcher` calls with different keys run concurrently without disturbing the active route or each other.
- **useFetchers** _(function)_ — `useFetchers: () => readonly Fetcher[]`
  Subscribe to the whole live fetcher collection — for a global busy view (e.g. "3 saving…"). Read each entry's `.snapshot()` for its state. Re-renders whenever any fetcher transitions or a new one is created.

### `@nifrajs/web-preact/i18n`

- **I18nProvider** _(function)_ — `I18nProvider: (props: I18nProviderProps) => VNode`
  Provide a {@link Formatter} (built from `locale` + `messages`) to the subtree. Memoized on `locale`/`messages`, so switching locale rebuilds it and re-renders consumers.
- **I18nProviderProps** _(interface)_ — `interface I18nProviderProps`
- **useT** _(function)_ — `useT: () => Formatter`
  Read the current {@link Formatter} (`{ locale, t, n, d }`). Throws if no `<I18nProvider>` is above.

### `@nifrajs/web-preact/image`

- **Image** _(function)_ — `Image: (props: ImageComponentProps) => VNode`
  Render a responsive, CLS-safe `<img>`. `width`+`height` are required (reserve layout space); `priority` marks the LCP image (`eager` + `fetchpriority="high"`). Extra DOM props pass through.
- **ImageComponentProps** _(interface)_ — `interface ImageComponentProps`

### `@nifrajs/web-preact/query`

- **UseQueryResult** _(interface)_ — `interface UseQueryResult<T>`
  A query's reactive {@link QueryState} plus `isPending` + `refetch`.
- **useQuery** _(function)_ — `useQuery: <T>(key: unknown, fn: () => Promise<T>) => UseQueryResult<T>`
  Subscribe to the keyed query for `key`, fetched via `fn`. Returns `{ status, data, error, isFetching, updatedAt, isPending, refetch }`. Concurrent `useQuery`s with the same key share one cache entry + one in-flight fetch (dedup). Refetches on mount and when the key changes; SSR-idle.
- **useQueryClient** _(function)_ — `useQueryClient: () => Pick<QueryClient, "invalidateQueries">`
  Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation).

## @nifrajs/web-react

### `@nifrajs/web-react`

- **reactAdapter** _(const)_ — `reactAdapter: RenderAdapter`
  The React server render adapter — pass to

### `@nifrajs/web-react/await`

- **Await** _(function)_ — `Await: <T>(props: AwaitProps<T>) => ReactNode`
  Render deferred loader data: show `fallback` until the `Deferred` settles (streamed in by the server), then `children(value)`. An already-resolved `resolve` (a client navigation awaited it) renders immediately. Pairs with a loader's `defer(...)`.
- **AwaitProps** _(interface)_ — `interface AwaitProps<T>`

### `@nifrajs/web-react/client`

- **errorBoundary** _(function)_ — `errorBoundary: (fallback: unknown) => unknown`
  Build an error-boundary chain element bound to `fallback` (a route's `_error` component). nifra's client codegen inserts it before the page in the matched chain; a render error in the subtree renders `fallback` with `{ data: { name, message } }` instead of crashing the app. DOM-transparent (it rend…
- **hydrate** _(function)_ — `hydrate: (chain: readonly unknown[], props: RenderProps, container: unknown) => void`
  Hydrate a server-rendered React layout `chain` (with the loader `props`) inside `container`.
- **mountRouter** _(function)_ — `mountRouter: (options: MountRouterOptions) => void`
  Hydrate a stateful React Router. `useSyncExternalStore` subscribes to the agnostic store and re-renders the matched layout chain on each store change — so client navigations swap routes without a full reload. `getServerSnapshot` (3rd arg) returns the initial state, matching the SSR markup on hydrat…

### `@nifrajs/web-react/content`

- **Content** _(function)_ — `Content: ({ html, as, ...rest }: ContentProps) => ReactElement`
  Render trusted HTML into a wrapper element. Extra props (`className`, `id`, `style`, …) pass through.
- **ContentProps** _(interface)_ — `interface ContentProps`

### `@nifrajs/web-react/fetcher`

- **FetcherHandle** _(interface)_ — `interface FetcherHandle`
  A fetcher's reactive {@link FetcherState} plus its imperative `load`/`submit`.
- **setMountedRouter** _(function)_ — `setMountedRouter: (router: ClientRouter | undefined) => void`
  Register (or clear) the router that owns fetchers — called by `mountRouter`. Not for app use.
- **useFetcher** _(function)_ — `useFetcher: (key: string) => FetcherHandle`
  Subscribe to the independent fetcher for `key` (created lazily, stable across renders). Returns its state (`pending`/`data`/`actionData`/`submission`) + `load`/`submit`. Multiple `useFetcher` calls with different keys run concurrently without disturbing the active route or each other.
- **useFetchers** _(function)_ — `useFetchers: () => readonly Fetcher[]`
  Subscribe to the whole live fetcher collection — for a global busy view (e.g. "3 saving…"). Read each entry's `.snapshot()` for its state. Re-renders whenever any fetcher transitions or a new one is created.

### `@nifrajs/web-react/i18n`

- **I18nProvider** _(function)_ — `I18nProvider: (props: I18nProviderProps) => ReactNode`
  Provide a {@link Formatter} (built from `locale` + `messages`) to the subtree. Memoized on `locale`/`messages`, so switching locale rebuilds it and re-renders consumers.
- **I18nProviderProps** _(interface)_ — `interface I18nProviderProps`
- **useT** _(function)_ — `useT: () => Formatter`
  Read the current {@link Formatter} (`{ locale, t, n, d }`). Throws if no `<I18nProvider>` is above.

### `@nifrajs/web-react/image`

- **Image** _(function)_ — `Image: (props: ImageComponentProps) => ReactElement`
  Render a responsive, CLS-safe `<img>`. `width`+`height` are required (reserve layout space); `priority` marks the LCP image (`eager` + `fetchpriority="high"`). Extra DOM props pass through.
- **ImageComponentProps** _(interface)_ — `interface ImageComponentProps`

### `@nifrajs/web-react/island`

- **Island** _(function)_ — `Island: ({ id, props, strategy, children }: IslandProps) => ReactNode`
  Render a `<nifra-island>` marker around server-rendered `children`. The client enhancer mounts the interactivity (see `mountIslands`). Props are JSON-encoded into `data-props`; React escapes the attribute value and the client reads the decoded `dataset.props`.
- **IslandProps** _(interface)_ — `interface IslandProps`

### `@nifrajs/web-react/query`

- **DehydratedState** _(interface)_ — `interface DehydratedState`
  A serializable snapshot of the cache's successful queries — the SSR→client bridge payload.
- **HydrationBoundary** _(function)_ — `HydrationBoundary: (props: { readonly state: DehydratedState | undefined; readonly children?: ReactNode; }) => ReactNode`
  Seed the context's {@link QueryClient} from a server {@link dehydrate} snapshot — the SSR data bridge. Wrap the app (inside `QueryClientProvider`) so server-prefetched queries are in the cache before the first client render, avoiding a loading flash. Hydration runs during render (idempotent, freshe…
- **QueryClientProvider** _(function)_ — `QueryClientProvider: (props: { readonly client: QueryClient; readonly children?: ReactNode; }) => ReactNode`
  Provide a {@link QueryClient} to the tree — required for SSR dehydrate/hydrate and for tests; a client-only app can omit it and rely on the built-in client-side singleton.
- **UseInfiniteQueryOptions** _(interface)_ — `interface UseInfiniteQueryOptions<T, P>`
  Options for {@link useInfiniteQuery} — the engine's {@link InfiniteQueryOptions} plus `enabled`.
- **UseInfiniteQueryResult** _(interface)_ — `interface UseInfiniteQueryResult<T, P>`
  An infinite query's reactive state + paging controls.
- **UseMutationResult** _(interface)_ — `interface UseMutationResult<TData, TVariables>`
  A mutation's reactive state + imperative controls (the TanStack `useMutation` shape).
- **UseQueryOptions** _(interface)_ — `interface UseQueryOptions`
  Options for {@link useQuery}.
- **UseQueryResult** _(interface)_ — `interface UseQueryResult<T>`
  A query's reactive {@link QueryState} plus `isPending` + `refetch`.
- **useInfiniteQuery** _(function)_ — `useInfiniteQuery: <T, P>(key: unknown, fn: (pageParam: P) => Promise<T>, options: UseInfiniteQueryOptions<T, P>) => UseInfiniteQueryResult<T, P>`
  Subscribe to a paged (infinite-scroll) query. Returns the accumulated `data.pages` plus `fetchNextPage`/`fetchPreviousPage`/`hasNextPage`/`hasPreviousPage`. Fetches the first page on mount. SSR-idle unless a `QueryClientProvider` supplies a hydrated client.
- **useMutation** _(function)_ — `useMutation: <TData, TVariables = void>(fn: (variables: TVariables) => Promise<TData>, callbacks?: MutationCallbacks<TData, TVariables>) => UseMutationResult<TData, TVariables>`
  A mutation hook (create/update/delete). Returns `{ mutate, mutateAsync, data, error, variables, isIdle, isPending, isError, isSuccess, reset }`. Invalidate affected queries from `onSuccess` via `useQueryClient().invalidateQueries(...)`. The handle is stable across renders; the latest `fn`/ callback…
- **useQuery** _(function)_ — `useQuery: <T>(key: unknown, fn: () => Promise<T>, options?: UseQueryOptions) => UseQueryResult<T>`
  Subscribe to the keyed query for `key`, fetched via `fn`. Returns `{ status, data, error, isFetching, updatedAt, isPending, isError, isSuccess, refetch }`. Concurrent `useQuery`s with the same key share one cache entry + one in-flight fetch (dedup). Fetches on mount and when the key changes; `enabl…
- **useQueryClient** _(function)_ — `useQueryClient: () => QueryClient`
  The active {@link QueryClient}: a `QueryClientProvider`'s client, else the client-side singleton, else a no-op (server / pre-hydration). Use it to `invalidateQueries`/`setQueryData`/`prefetchQuery`.

### `@nifrajs/web-react/router`

- **Link** _(const)_ — `Link: import("react").ForwardRefExoticComponent<LinkProps & import("react").RefAttributes<HTMLAnchorElement>>`
  A client-navigating anchor. Renders a real `<a href={to}>` (so it's a working link before hydration and for right-click / open-in-new-tab), and on a plain left-click navigates through the router instead of a full reload. Calling `navigate` + `preventDefault` here means `installHistory`'s document-l…
- **LinkProps** _(interface)_ — `interface LinkProps`
  {@link Link} props: every `<a>` attribute except `href` (set from `to`), plus `to` + `replace`.
- **Location** _(interface)_ — `interface Location`
  The parsed current location. `hash` is always `""` — the fragment is client-only and never reaches the router state / server, so exposing a live hash would hydration-mismatch; read `window.location.hash` directly (in an effect) if you truly need it.
- **NavLink** _(const)_ — `NavLink: import("react").ForwardRefExoticComponent<NavLinkProps & import("react").RefAttributes<HTMLAnchorElement>>`
  A {@link Link} that knows whether it points at the current location. Adds `aria-current="page"` when active and resolves function-form `className`/`style`/`children` with `{ isActive, isPending }`. Default matching is prefix-on-segment-boundary (so `/users` is active on `/users/7`); pass `end` for …
- **NavLinkProps** _(interface)_ — `interface NavLinkProps`
  {@link NavLink} props — like {@link LinkProps}, but `className`/`style`/`children` may be functions of the active state, and `end`/`caseSensitive` tune matching.
- **NavLinkRenderProps** _(interface)_ — `interface NavLinkRenderProps`
  The state a {@link NavLink}'s function-form `className`/`style`/`children` receive.
- **Navigate** _(function)_ — `Navigate: ({ to, replace }: NavigateProps) => null`
  Declaratively navigate on mount — the component analogue of `useNavigate` (e.g. a guard that renders `<Navigate to="/login" replace />`). Navigates in an effect, so it's a safe no-op during SSR (renders `null`); the redirect happens once on the client after hydration.
- **NavigateFunction** _(type)_ — `type NavigateFunction = (to: string | number, options?: NavigateOptions) => void`
  A programmatic navigate: a string path (push, or replace via `{ replace: true }`) or a history delta (`-1`/`1`). A no-op on the server / before hydration (a render-time navigate isn't valid — use {@link Navigate}, which navigates in an effect).
- **NavigateProps** _(interface)_ — `interface NavigateProps`
  {@link Navigate} props: the destination `to` and whether to `replace` the history entry.
- **Navigation** _(interface)_ — `interface Navigation`
  The current navigation state, mirroring the Remix `useNavigation()` shape for familiarity.
- **RouterContext** _(const)_ — `RouterContext: import("react").Context<RouterContextValue>`
  Router context. The default ({} params, "" path) is what a component sees when rendered outside a nifra route tree — the hooks stay defined (no throw) so a stray `useParams` degrades gracefully.
- **RouterContextValue** _(interface)_ — `interface RouterContextValue`
  The current route the routing hooks read. Provided by `compose` on SSR + client mount alike.
- **SearchParamsInit** _(type)_ — `type SearchParamsInit = URLSearchParams | Record<string, string | readonly string[]> | string`
  The value forms `setSearchParams` accepts.
- **SetSearchParams** _(type)_ — `type SetSearchParams = ( next: SearchParamsInit | ((prev: URLSearchParams) => SearchParamsInit), options?: NavigateOptions, ) => void`
  Set the query string. Accepts a `URLSearchParams`, a record, a raw string, or an updater of the current params; navigates to the same pathname with the new query (push, or replace via options).
- **useLocation** _(function)_ — `useLocation: () => Location`
  The current {@link Location} (`pathname`/`search`/`hash`), derived from the router context.
- **useNavigate** _(function)_ — `useNavigate: () => NavigateFunction`
  Get the {@link NavigateFunction}. Stable across renders; resolves the browser navigate at call time (so it works as soon as `installHistory` has run, and no-ops before then / on the server).
- **useNavigation** _(function)_ — `useNavigation: () => Navigation`
  Observe client navigation to drive loading UI (a top-bar spinner, dimmed content, a skeleton). nifra navigates imperatively - it fetches the next route's chunk + loader data while the current route stays on screen, then swaps - so `pending` is the signal for "a transition is in flight," not a Suspe…
- **useParams** _(function)_ — `useParams: <T extends Record<string, string | undefined> = Record<string, string>>() => Readonly<T>`
  The matched route's decoded path params — `/users/:id` on `/users/7` → `{ id: "7" }`. SSR-correct: `compose` provides the same value server-side (from the request match) and client-side (from router state), so a param rendered into markup doesn't flash on hydration.
- **usePending** _(function)_ — `usePending: () => boolean`
  Convenience boolean form of {@link useNavigation}: `true` while a client navigation is in flight.
- **useSearchParams** _(function)_ — `useSearchParams: () => readonly [URLSearchParams, SetSearchParams]`
  The current query as a `URLSearchParams` (SSR-correct via the router context) plus a setter that navigates to the new query. Mirrors react-router's `useSearchParams` tuple.

## @nifrajs/web-solid

### `@nifrajs/web-solid`

- **solidAdapter** _(const)_ — `solidAdapter: RenderAdapter`
  The Solid server render adapter — pass to
- **solidBunPlugin** _(function)_ — `solidBunPlugin: (generate: "dom" | "ssr") => BunPlugin`
  Bun build/runtime plugin that compiles Solid components with Babel — `generate: "ssr"` for the server, `"dom"` for the client, `hydratable` so SSR and hydrate align. Solid's reactive-JSX compiler ships only as a Babel plugin (no swc/native port); this runs at build time, on `.tsx` files only.

### `@nifrajs/web-solid/await`

- **Await** _(function)_ — `Await: <T>(props: AwaitProps<T>) => JSX.Element`
  Render deferred loader data: show `fallback` until the `Deferred` settles (streamed in by the server), then `children(value)`. An already-resolved `resolve` (a client navigation awaited it) renders immediately. Pairs with a loader's `defer(...)`.
- **AwaitProps** _(interface)_ — `interface AwaitProps<T>`

### `@nifrajs/web-solid/client`

- **errorBoundary** _(function)_ — `errorBoundary: (fallback: unknown) => unknown`
  Build an error-boundary chain element bound to `fallback` (a route's `_error` component). nifra's client codegen inserts it before the page in the matched chain; a render error in the subtree renders `fallback` with `{ data: { name, message } }` (via Solid's `<ErrorBoundary>`) instead of crashing. …
- **hydrate** _(function)_ — `hydrate: (chain: readonly unknown[], props: RenderProps, container: unknown) => void`
  Hydrate a server-rendered Solid layout `chain` (with the loader `props`) inside `container`.
- **mountRouter** _(function)_ — `mountRouter: (options: MountRouterOptions) => void`
  Mount a Solid Router driven by the agnostic store. The first render *hydrates* the SSR'd chain. The route's props are exposed as **getters over a signal** created inside the render root, so:

### `@nifrajs/web-solid/content`

- **Content** _(function)_ — `Content: (props: ContentProps) => JSX.Element`
  Render trusted HTML into a wrapper element. Extra props pass through reactively.
- **ContentProps** _(interface)_ — `interface ContentProps`

### `@nifrajs/web-solid/fetcher`

- **FetcherHandle** _(interface)_ — `interface FetcherHandle`
  A fetcher's reactive state accessor plus its imperative `load`/`submit`.
- **createFetcher** _(function)_ — `createFetcher: (key: string) => FetcherHandle`
  Bind the independent fetcher for `key` (created lazily, stable). Returns a reactive `state()` accessor + `load`/`submit`. Multiple `createFetcher` calls with different keys run concurrently without disturbing the active route or each other. Call inside a component (owns the subscription).
- **setMountedRouter** _(function)_ — `setMountedRouter: (router: ClientRouter | undefined) => void`
  Register (or clear) the router that owns fetchers — called by `mountRouter`. Not for app use.
- **useFetchers** _(function)_ — `useFetchers: () => Accessor<readonly Fetcher[]>`
  Bind the whole live fetcher collection — for a global busy view. Returns a reactive accessor; read each entry's `.snapshot()` for its state. Updates whenever any fetcher transitions or one is created.

### `@nifrajs/web-solid/i18n`

- **I18nProvider** _(function)_ — `I18nProvider: (props: I18nProviderProps) => JSX.Element`
  Provide a {@link Formatter} (built from `locale` + `messages`) to the subtree. Memoized on `locale`/`messages`, so switching locale rebuilds it.
- **I18nProviderProps** _(interface)_ — `interface I18nProviderProps`
- **useT** _(function)_ — `useT: () => Formatter`
  Read the current {@link Formatter} (`{ locale, t, n, d }`). Throws if no `<I18nProvider>` is above. nifra switches locale by re-navigating, which re-runs the consuming component with the new catalog.

### `@nifrajs/web-solid/image`

- **Image** _(function)_ — `Image: (props: ImageComponentProps) => JSX.Element`
  Render a responsive, CLS-safe `<img>`. `width`+`height` are required (reserve layout space); `priority` marks the LCP image (`eager` + `fetchpriority="high"`). Extra DOM props pass through.
- **ImageComponentProps** _(interface)_ — `interface ImageComponentProps`

### `@nifrajs/web-solid/mdx`

- **solidMdxBunPlugin** _(function)_ — `solidMdxBunPlugin: (generate: "dom" | "ssr") => BunPlugin`
  Build a `Bun.build` plugin that loads `.mdx` files as Solid components. `generate`: `"ssr"` for the server build, `"dom"` for the client (matches `solidBunPlugin`).

### `@nifrajs/web-solid/mdx-runtime`

- **useMDXComponents** _(function)_ — `useMDXComponents: () => Record<string, (props: Record<string, unknown>) => unknown>`
  Returns the intrinsic-element → Solid-component map MDX content uses. Merge in your own overrides by passing `components` to the MDX content component (they take precedence).

### `@nifrajs/web-solid/query`

- **CreateQueryResult** _(interface)_ — `interface CreateQueryResult<T>`
  A query's reactive state accessor plus `refetch`.
- **createQuery** _(function)_ — `createQuery: <T>(key: unknown, fn: () => Promise<T>) => CreateQueryResult<T>`
  Bind the keyed query for `key`, fetched via `fn`. Returns a reactive `state()` accessor + `refetch`. Concurrent `createQuery`s with the same key share one cache entry + one in-flight fetch (dedup). Fetches on mount; SSR-idle. Call inside a component (owns the subscription).
- **useQueryClient** _(function)_ — `useQueryClient: () => Pick<QueryClient, "invalidateQueries">`
  Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation).

### `@nifrajs/web-solid/svg`

- **solidSvgComponentBunPlugin** _(function)_ — `solidSvgComponentBunPlugin: (generate: "dom" | "ssr") => BunPlugin`
  The Solid SVG-component plugin. `generate` selects the Solid `"dom"`/`"ssr"` output, matching `solidBunPlugin`. A plain `import "./icon.svg"` (asset URL) is untouched - only `?component` matches.

## @nifrajs/web-svelte

### `@nifrajs/web-svelte`

- **svelteAdapter** _(const)_ — `svelteAdapter: RenderAdapter`
  The Svelte server render adapter — pass to
- **svelteBunPlugin** _(function)_ — `svelteBunPlugin: (generate: "dom" | "ssr") => BunPlugin`

### `@nifrajs/web-svelte/client`

- **errorBoundary** _(function)_ — `errorBoundary: (fallback: unknown) => NifraSvelteErrorBoundary`
  Wrap a route's `_error` component as a boundary marker for `Chain.svelte` to render.
- **hydrate** _(function)_ — `hydrate: (chain: readonly unknown[], props: RenderProps, container: unknown) => void`
  Hydrate a server-rendered Svelte layout `chain` (with the loader `props`) inside `container`.
- **mountRouter** _(function)_ — `mountRouter: (options: MountRouterOptions) => void`
  Hydrate a stateful Svelte Router. The `Router` component holds the store snapshot in `$state` and re-renders the matched layout chain on each store change — so client navigations swap routes without a full reload. Its initial render matches the SSR markup (the server rendered `Chain` for the same m…

### `@nifrajs/web-svelte/fetcher`

- **FetcherStore** _(type)_ — `type FetcherStore`
  A fetcher store: a `Readable<FetcherState>` (read via `$`) plus imperative `load`/`submit`.
- **setMountedRouter** _(function)_ — `setMountedRouter: (router: ClientRouter | undefined) => void`
  Register (or clear) the router that owns fetchers — called by `mountRouter`. Not for app use.
- **useFetcher** _(function)_ — `useFetcher: (key: string) => FetcherStore`
  Subscribe to the independent fetcher for `key` (created lazily, stable across renders). Returns a store of its state (`pending`/`data`/`actionData`/`submission`) augmented with `load`/`submit`. Multiple `useFetcher` calls with different keys run concurrently without disturbing the active route.
- **useFetchers** _(function)_ — `useFetchers: () => Readable<readonly Fetcher[]>`
  Subscribe to the whole live fetcher collection — for a global busy view (e.g. "3 saving…"). Read each entry's `.snapshot()` for its state. The store updates whenever any fetcher transitions or a new one is created.

### `@nifrajs/web-svelte/i18n`

- **I18nProvider** _(const)_ — `I18nProvider: Component<I18nProviderProps, {}, string>`
- **I18nProviderProps** _(interface)_ — `interface I18nProviderProps`
  Hand-written types for `I18nProvider.svelte` (consumers resolve these via the `./i18n` re-export).
- **useT** _(function)_ — `useT: () => Formatter`
  Read the current {@link Formatter} (`{ locale, t, n, d }`). Throws if no `<I18nProvider>` is above. nifra switches locale by re-navigating, which re-runs the consuming component with the new catalog.

### `@nifrajs/web-svelte/mdx`

- **svelteMdxBunPlugin** _(function)_ — `svelteMdxBunPlugin: (generate: "dom" | "ssr") => BunPlugin`
  Build a `Bun.build` plugin that loads `.mdx` files as Svelte components via mdsvex. `generate`: `"ssr"` for the server build, `"dom"` for the client (matches `svelteBunPlugin`).

### `@nifrajs/web-svelte/plugin`

- **svelteBunPlugin** _(function)_ — `svelteBunPlugin: (generate: "dom" | "ssr") => BunPlugin`

### `@nifrajs/web-svelte/query`

- **QueryStore** _(type)_ — `type QueryStore<T> = Readable<QueryState<T>> & { /** Force a refetch (ignores `staleTime`). */ readonly refetch: () => Promise<T> }`
  A query store: a `Readable<QueryState<T>>` (read via `$`) plus `refetch`.
- **useQuery** _(function)_ — `useQuery: <T>(key: unknown, fn: () => Promise<T>) => QueryStore<T>`
  Subscribe to the keyed query for `key`, fetched via `fn`. Returns a store of `{ status, data, error, isFetching, updatedAt }` augmented with `refetch`. Fetches on mount (first `$`-subscription); SSR-idle.
- **useQueryClient** _(function)_ — `useQueryClient: () => Pick<QueryClient, "invalidateQueries">`
  Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation).

### `@nifrajs/web-svelte/svg`

- **svelteSvgComponentBunPlugin** _(function)_ — `svelteSvgComponentBunPlugin: (generate: "dom" | "ssr") => BunPlugin`
  The Svelte SVG-component plugin. `generate` selects Svelte's `"client"`/`"server"` output, matching `svelteBunPlugin`.
- **svgToSvelte** _(function)_ — `svgToSvelte: (xml: string) => string`
  Wrap raw SVG XML in a Svelte 5 component: strip XML noise, spread props onto the root `<svg>`.

## @nifrajs/web-vanilla

- **HtmlValue** _(type)_ — `type HtmlValue = | string | number | bigint | boolean | null | undefined | Template | RawHtml | ReadonlyArray<HtmlValue>`
  What an interpolation may be: escaped primitives, nested templates/raw, arrays of the same. `null`/`undefined`/`false` render as nothing (conditional rendering: `cond && html\`…\``).
- **RawHtml** _(class)_ — `class RawHtml`
  Branded wrapper marking a string as pre-trusted markup. Construct only via {@link raw}.
- **Template** _(class)_ — `class Template`
  A rendered HTML fragment — what `html` returns and components produce. Stringified once.
- **VanillaComponent** _(type)_ — `type VanillaComponent = (props: RenderProps & { children?: Template }) => Template`
  A vanilla "component": a plain function from props to a {@link Template}. The page (innermost chain element) receives the loader {@link RenderProps}; a layout receives `{ children }` — the already-rendered inner fragment — plus the same render props, mirroring the React/Preact adapters' `children` …
- **compose** _(function)_ — `compose: (chain: readonly unknown[], props: RenderProps) => Template`
  Fold a layout chain (outermost layout → page) into one {@link Template}: render the page with the loader props, then wrap upward, each layout receiving the inner fragment as `children`.
- **html** _(function)_ — `html: (strings: TemplateStringsArray, ...values: HtmlValue[]) => Template`
  The tag: `` html`<p>${user.name}</p>` `` → an escaped {@link Template}.
- **raw** _(function)_ — `raw: (trusted: string) => RawHtml`
  Mark a string as trusted, pre-escaped markup — it is emitted verbatim. The deliberate escape hatch (CMS-sanitized HTML, pre-rendered markdown): every call site is greppable, exactly like React's dangerouslySetInnerHTML, without the JSX.
- **vanillaAdapter** _(const)_ — `vanillaAdapter: RenderAdapter`
  The zero-framework server render adapter — pass to

## @nifrajs/web-vue

### `@nifrajs/web-vue`

- **vueAdapter** _(const)_ — `vueAdapter: RenderAdapter`
  The Vue server render adapter — pass to

### `@nifrajs/web-vue/await`

- **Await** _(const)_ — `Await: import("vue").DefineComponent<import("vue").ExtractPropTypes<{ resolve: { required: true; }; }>, () => VNode | undefined, {}, {}, {}, import("vue").ComponentOptionsMixin, import("vue").ComponentOptionsMixin, {}, …`
  `<Await :resolve="deferredOrValue">` with scoped slots `default(value)`, `fallback()`, `error(err)`. An already-resolved `resolve` (a plain value, or a client navigation that awaited it) renders `default` immediately. A `Deferred` renders `fallback` until it settles on the client.

### `@nifrajs/web-vue/client`

- **errorBoundary** _(function)_ — `errorBoundary: (fallback: unknown) => unknown`
  Build an error-boundary chain element bound to `fallback` (a route's `_error` component). nifra's client codegen inserts it before the page in the matched chain; a render error in the subtree is captured (`onErrorCaptured`) and renders `fallback` with `{ data: { name, message } }` instead of crashi…
- **hydrate** _(function)_ — `hydrate: (chain: readonly unknown[], props: RenderProps, container: unknown) => void`
  Hydrate a server-rendered Vue layout `chain` (with the loader `props`) inside `container`.
- **mountRouter** _(function)_ — `mountRouter: (options: MountRouterOptions) => void`
  Hydrate a stateful Vue Router. A `shallowRef` holds the store snapshot; `router.subscribe` writes each new snapshot into it, so the root re-renders the matched layout chain on every store change — client navigations swap routes without a full reload. The initial snapshot matches the SSR markup.

### `@nifrajs/web-vue/content`

- **Content** _(const)_ — `Content: import("vue").DefineComponent<import("vue").ExtractPropTypes<{ html: { type: StringConstructor; required: true; }; as: { type: StringConstructor; default: string; }; }>, () => import("vue").VNode<import("vue").…`
  Render trusted HTML into a wrapper element. `inheritAttrs: false` + manual attr spread so passthrough (`class`, `id`, `style`, …) lands on the wrapper exactly once.

### `@nifrajs/web-vue/fetcher`

- **FetcherHandle** _(interface)_ — `interface FetcherHandle`
  A fetcher's reactive {@link FetcherState} (read `.value`) plus its imperative `load`/`submit`.
- **setMountedRouter** _(function)_ — `setMountedRouter: (router: ClientRouter | undefined) => void`
  Register (or clear) the router that owns fetchers — called by `mountRouter`. Not for app use.
- **useFetcher** _(function)_ — `useFetcher: (key: string) => FetcherHandle`
  Subscribe to the independent fetcher for `key` (created lazily, stable across renders). Returns a reactive `state` ref (`pending`/`data`/`actionData`/`submission`) + `load`/`submit`. Multiple `useFetcher` calls with different keys run concurrently without disturbing the active route.
- **useFetchers** _(function)_ — `useFetchers: () => Readonly<ShallowRef<readonly Fetcher[]>>`
  Subscribe to the whole live fetcher collection — for a global busy view (e.g. "3 saving…"). Read each entry's `.snapshot()` for its state. The ref updates whenever any fetcher transitions or a new one is created.

### `@nifrajs/web-vue/i18n`

- **I18nProvider** _(const)_ — `I18nProvider: import("vue").DefineComponent<import("vue").ExtractPropTypes<{ locale: { type: StringConstructor; required: true; }; messages: { type: PropType<Messages>; required: true; }; }>, () => import("vue").VNode<i…`
  Provide a {@link Formatter} (built from `locale` + `messages`) to the subtree. Recomputes when `locale`/`messages` change, so a locale switch re-renders consumers. Renders its default slot.
- **useT** _(function)_ — `useT: () => Formatter`
  Read the current {@link Formatter} (`{ locale, t, n, d }`). Throws if no `<I18nProvider>` is above.

### `@nifrajs/web-vue/image`

- **Image** _(const)_ — `Image: import("vue").DefineComponent<import("vue").ExtractPropTypes<{ src: { type: StringConstructor; required: true; }; width: { type: NumberConstructor; required: true; }; height: { type: NumberConstructor; required: …`

### `@nifrajs/web-vue/plugin`

- **compileVue** _(function)_ — `compileVue: (source: string, filename: string, generate: "dom" | "ssr") => string`
  Compile a `.vue` SFC to a JS module: the component as the **default export**, plus the plain `<script>`'s named exports (`loader`/`action`/`meta` — nifra's route convention) preserved as-is. `<template>` compiles to a `render` (dom) or `ssrRender` (ssr) function bound onto the component.
- **compileVueStyles** _(function)_ — `compileVueStyles: (source: string, filename: string) => string`
  Compile a `.vue` SFC's `<style>` blocks to a single CSS string (scoped selectors rewritten to `[data-v-<id>]` when `scoped`). Returns `""` for a style-less SFC. The matching scope attribute is baked into the markup by {@link compileVue}.
- **vueBunPlugin** _(function)_ — `vueBunPlugin: (generate: "dom" | "ssr") => BunPlugin`
  The `.vue` compiler Bun plugin. `"dom"` → client-hydratable output; `"ssr"` → server render. On the `"dom"` build, a SFC's `<style>` CSS is emitted as a virtual `?vue-css` module that `Bun.build`'s CSS bundler folds into the app stylesheet (served as a `<link>`). The `"ssr"` build emits no CSS — th…

### `@nifrajs/web-vue/query`

- **UseQueryResult** _(interface)_ — `interface UseQueryResult<T>`
  A query's reactive {@link QueryState} (read `.value`) plus `refetch`.
- **useQuery** _(function)_ — `useQuery: <T>(key: unknown, fn: () => Promise<T>) => UseQueryResult<T>`
  Subscribe to the keyed query for `key`, fetched via `fn`. Returns a reactive `state` ref (`status`, `data`, `error`, `isFetching`, `updatedAt`) + `refetch`. Concurrent `useQuery`s with the same key share one cache entry + one in-flight fetch (dedup). Fetches on mount; SSR-idle.
- **useQueryClient** _(function)_ — `useQueryClient: () => Pick<QueryClient, "invalidateQueries">`
  Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation).

### `@nifrajs/web-vue/svg`

- **svgToVueSfc** _(function)_ — `svgToVueSfc: (xml: string) => string`
  Wrap raw SVG XML in a template-only Vue SFC (single root → Vue inherits attrs onto the `<svg>`).
- **vueSvgComponentBunPlugin** _(function)_ — `vueSvgComponentBunPlugin: (generate: "dom" | "ssr") => BunPlugin`
  The Vue SVG-component plugin. `generate` selects Vue's client/SSR render, matching `vueBunPlugin`.

## @nifrajs/workers

- **WebSocketHubApp** _(interface)_ — `interface WebSocketHubApp<Env = unknown>`
  The nifra-app surface the hub needs — every `server()` app satisfies it.
- **WebSocketHubClass** _(type)_ — `type WebSocketHubClass<Env> = new ( state: DurableObjectStateLike, env: Env, ) => { fetch(request: Request): Promise<Response> }`
  The Durable Object class shape `createWebSocketHub` returns.
- **createWebSocketHub** _(function)_ — `createWebSocketHub: <Env = unknown>(app: WebSocketHubApp<Env>) => WebSocketHubClass<Env>`
  Build a Durable Object class that serves an app's `app.ws()` routes with **cross-connection broadcast**. Every WebSocket accepted here lives in the DO's isolate, and the app's `TopicRegistry` lives there too — so `ws.subscribe(topic)` and `app.publish(topic, data)` (called from the WS lifecycle) re…

## create-nifra

- **AGENTS_MD_PATH** _(const)_ — `AGENTS_MD_PATH: "AGENTS.md"`
- **AgentFileSpec** _(interface)_ — `interface AgentFileSpec`
  Identifies a generated agent-discovery file: where it goes (relative to the project root) and how to produce its content. `merge` is for files that augment an existing one (AGENTS.md) rather than own it.
- **CLAUDE_MD_PATH** _(const)_ — `CLAUDE_MD_PATH: "CLAUDE.md"`
- **CURSOR_MCP_JSON_PATH** _(const)_ — `CURSOR_MCP_JSON_PATH: ".cursor/mcp.json"`
- **MCP_CLI_VERSION** _(const)_ — `MCP_CLI_VERSION: string`
  The `@nifrajs/cli` version the launch command pins to — DERIVED at load time from this package's own `version`, never hardcoded. `fixed` changeset versioning ([["@nifrajs/*", "create-nifra", "nifra"]] in `.changeset/config.json`) bumps `create-nifra` and `@nifrajs/cli` in lockstep, so `create-nifra…
- **MCP_CONFIG** _(const)_ — `MCP_CONFIG: McpConfig`
  The one canonical MCP config object both registries serialize — the anti-drift seam.
- **MCP_JSON_PATH** _(const)_ — `MCP_JSON_PATH: ".mcp.json"`
  The standalone files this module fully owns (whole-file generators). AGENTS.md is handled separately because create-nifra builds it from `agents.ts` and the retrofit command appends a section to it.
- **MCP_SERVER_ARGS** _(const)_ — `MCP_SERVER_ARGS: readonly [`@nifrajs/cli@${string}`, "mcp"]`
- **MCP_SERVER_COMMAND** _(const)_ — `MCP_SERVER_COMMAND: "bunx"`
  The MCP launch command, shared by `.mcp.json` and `.cursor/mcp.json`. See the module header for why the package is named explicitly rather than relying on the bare `nifra` bin.
- **McpConfig** _(interface)_ — `interface McpConfig`
  Claude Code / Cursor MCP config shape: a map of server name → launch config.
- **McpServerConfig** _(interface)_ — `interface McpServerConfig`
  The server entry registered under the `nifra` key in both Claude Code's and Cursor's MCP config.
- **agentsMcpSection** _(function)_ — `agentsMcpSection: () => string`
  The "## MCP server" section appended to a scaffolded (or retrofitted) `AGENTS.md`, so non-Claude agents (Cursor, and anything that reads `AGENTS.md`) also learn the MCP exists and what to prefer. Mirrors the CLAUDE.md preamble's guidance without the Claude-specific `@import`.
- **claudeMd** _(function)_ — `claudeMd: () => string`
  `CLAUDE.md` — Claude Code reads this automatically. It is deliberately NOT a copy of `AGENTS.md`: a short preamble that (1) tells Claude this project ships a nifra MCP, registered in `.mcp.json`, and to PREFER it, and (2) pulls in the full cookbook with Claude Code's `@file` import directive on its…
- **mcpJson** _(function)_ — `mcpJson: () => string`
  Serialize the canonical MCP config as the JSON written to `.mcp.json` and `.cursor/mcp.json`. Trailing newline so the file is POSIX-clean and diffs don't flag a missing EOL.

## nifra

- **AdmissionController** _(interface)_ — `interface AdmissionController`
  A capacity-admission gate. Decides, per request, whether the instance has capacity to run it now - bounding *concurrency*, which rate limits (frequency) and deadlines (duration) do not. Provide an implementation (see `@nifrajs/middleware`'s `createAdmissionController`) as {@link ServerOptions.admis…
- **AdmissionDecision** _(type)_ — `type AdmissionDecision = | { readonly admitted: true; release(): void } | { readonly admitted: false; readonly response: Response }`
  The outcome of a capacity-admission decision. `admitted` requests carry a `release` the server calls exactly once when the response is finalized; a shed request carries a ready `429` Response.
- **AnyServer** _(type)_ — `type AnyServer = Server<any, any>`
- **Context** _(interface)_ — `interface Context<Path extends string = string, S extends RouteSchema = RouteSchema>`
  Handler context. `params` are inferred from the path; `body` and `query` are the validated outputs of their schemas when declared (else `undefined` / raw `URLSearchParams`).
- **CookieOptions** _(interface)_ — `interface CookieOptions`
  Attributes for a `Set-Cookie`. `expires` is a `Date`; `maxAge` is in **seconds**.
- **DurableObjectNamespaceLike** _(interface)_ — `interface DurableObjectNamespaceLike`
  Structural view of a Cloudflare Durable Object namespace binding — keeps `@cloudflare/workers-types` out of `@nifrajs/core`. The real `DurableObjectNamespace` satisfies it.
- **ExecutionContext** _(interface)_ — `interface ExecutionContext`
  A Cloudflare Workers-style execution context (the `fetch` 3rd arg). Structural — only `waitUntil` is used; declared here so `@nifrajs/core` needs no Workers type dependency.
- **FRAMEWORK_NAME** _(const)_ — `FRAMEWORK_NAME: "Nifra"`
  Single source of truth for the framework's user-facing name.
- **FrameworkError** _(class)_ — `class FrameworkError`
  Base class for every error the framework throws. Carries a stable, string `code` so callers can branch on the failure programmatically rather than matching on message text. Messages are prefixed with the brand name.
- **FrameworkName** _(type)_ — `type FrameworkName = typeof FRAMEWORK_NAME`
- **Handler** _(type)_ — `type Handler<Path extends string, S extends RouteSchema = RouteSchema, Ctx = EmptyContext> = (ctx: Context<Path, S> & Ctx) => MaybePromise<ResponseOf<S>>`
  Public handler shape: context typed from the path, the (optional) schema, and any accumulated middleware context `Ctx` (from `derive`/`decorate`).
- **IdentityPlugin** _(type)_ — `type IdentityPlugin = (<S extends AnyServer>(app: S) => S) & { readonly pluginName?: string }`
  A named type-identity plugin built with {@link defineIdentityPlugin}. It returns the same concrete server type it receives, preserving the caller's typed registry and context across `.use()` while still allowing the plugin to register runtime hooks or handlers.
- **InferInput** _(type)_ — `type InferInput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["input"]`
- **InferOutput** _(type)_ — `type InferOutput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["output"]`
- **LogFields** _(type)_ — `type LogFields = Record<string, unknown>`
  Structured, redacting logger. The framework logs through this interface so secrets/PII are scrubbed once, centrally (per the project's logging rule), not at each call site. Bring your own by passing `logger` to `server()`.
- **Logger** _(interface)_ — `interface Logger`
- **METHODS** _(const)_ — `METHODS: readonly ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]`
  HTTP methods the router accepts.
- **McpPromptDescriptor** _(interface)_ — `interface McpPromptDescriptor`
  An app-declared MCP prompt - a reusable prompt template an agent can fetch through `nifra mcp`.
- **McpResourceDescriptor** _(interface)_ — `interface McpResourceDescriptor`
  An app-declared MCP resource - read-only data an agent can fetch through `nifra mcp`.
- **Method** _(type)_ — `type Method = (typeof METHODS)[number]`
- **Middleware** _(interface)_ — `interface Middleware`
  A bundle of lifecycle hooks applied together via {@link Server.use} - the unit `@nifrajs/middleware` ships (cors, security headers, rate-limit). Every hook is optional and wired to its lifecycle point. Middleware is context-agnostic (sees the base `Context`); `use` does no context-type merging - th…
- **NifraPlugin** _(type)_ — `type NifraPlugin<In extends AnyServer = AnyServer, Out extends AnyServer = In> = (( app: In, ) => Out) & { readonly pluginName?: string }`
  A nifra **plugin**: a function that augments an app - calling `use`/`derive`/`decorate` and/or registering routes - and returns it. Because `derive`/`decorate` are type-threaded, an **inline** `app.use((a) => a.derive(...).decorate(...))` carries the added context to handlers defined after it (the …
- **NifraWebSocket** _(interface)_ — `interface NifraWebSocket<Data = unknown>`
  The portable socket handed to WS lifecycle callbacks. Each adapter wraps its native socket.
- **NodeServeOutcome** _(type)_ — `type NodeServeOutcome`
  What {@link Server.resolveNode} returns: either a plain-data render the `@nifrajs/node` adapter writes to the socket directly (`kind: "json"` - status + headers + cookies + a pre-stringified body, **no** undici `Response` built or drained), a marked buffered response body (`kind: "body"` - e.g.
- **OnRequestResult** _(type)_ — `type OnRequestResult = Response | Request | undefined`
- **Params** _(type)_ — `type Params<Path extends string> = Prettify<RawParams<Path>>`
- **Platform** _(interface)_ — `interface Platform<Env = unknown>`
  Runtime platform inputs, passed as `app.fetch(request, platform)`. Edge adapters (e.g. Cloudflare Workers) supply `env` (bindings) + `waitUntil`; Bun/Node/Deno omit them. Optional + runtime-neutral, so `app.fetch` stays a Web-standard handler.
- **Prettify** _(type)_ — `type Prettify<T> = { [K in keyof T]: T[K] } & {}`
  Flattens an intersection into a single object type for readable hovers.
- **PromptArgument** _(interface)_ — `interface PromptArgument`
  One declared argument of an MCP prompt, surfaced in `prompts/list`.
- **PromptMessage** _(interface)_ — `interface PromptMessage`
  A message in an MCP prompt's rendered output (see {@link Server.prompt}).
- **RedactOptions** _(interface)_ — `interface RedactOptions`
  Tunes redaction. Key-name redaction always runs; the rest is **opt-in**: - `keyParts` — extra case-insensitive key fragments, added to the built-in denylist. - `valuePatterns` — regexes matched against string **values** *and* the log message; each match is replaced with the placeholder. This is the…
- **Registry** _(type)_ — `type Registry = Record<string, Record<string, RouteInfo>>`
  The accumulated, type-level map of every route on a Server: path → method → RouteInfo.
- **ResponseControls** _(interface)_ — `interface ResponseControls`
  Mutable response controls a handler may write to before returning.
- **ResponseFinalization** _(interface)_ — `interface ResponseFinalization`
  The terminal response-pipeline outcome observed after every transforming `onResponse` hook.
- **RouteConfigError** _(class)_ — `class RouteConfigError`
  Thrown at route registration when a route is misconfigured. This is the boot-time rejection layer: loud and early, never deferred to the first request.
- **RouteConfigErrorCode** _(type)_ — `type RouteConfigErrorCode = | "DUPLICATE_ROUTE" | "DUPLICATE_PARAM" | "PARAM_NAME_CONFLICT" | "INVALID_PATH" | "INVALID_PARAM_NAME" | "WILDCARD_NOT_LAST" | "INVALID_METHOD" | "INVALID_ASSURANCE" | "INVALID_IDEMPOTENCY"`
  Stable codes for boot-time (L2) route configuration failures.
- **RouteDescriptor** _(interface)_ — `interface RouteDescriptor`
  A registered route's public descriptor - method, path, and input schemas. The router trie discards the original patterns, so this flat list is what lets tools (e.g. `toOpenAPI`) enumerate routes after registration.
- **RouteInfo** _(interface)_ — `interface RouteInfo`
  One route's input/output shape as the **client** will consume it. `query`/`body` are `never` when the route declares no schema for them, so the client can detect "this route takes no body" via `[body] extends [never]`. `output` is the handler's raw return type (the client applies `Jsonify` when rea…
- **RouteSchema** _(interface)_ — `interface RouteSchema`
  Per-route input schemas. Each is any Standard Schema (zod/valibot/arktype/…).
- **Router** _(class)_ — `class Router<T>`
  Radix-style segment trie router. Matching precedence is static > param > wildcard. Parameter/wildcard values are returned RAW (not percent-decoded); the server boundary decodes and rejects malformed encodings with a 400, keeping this layer pure and allocation-light.
- **RouterMatch** _(type)_ — `type RouterMatch<T>`
  Result of {@link Router.find}. The `found: false` cases deliberately separate a missing path (404) from a path that exists for other methods (405), so the server layer can answer correctly and populate an `Allow` header.
- **RunningServer** _(interface)_ — `interface RunningServer`
  The handle `listen()` returns - the slice of Bun's server nifra holds and exposes. Declared explicitly (rather than `ReturnType<typeof Bun.serve>`) so the public type surface doesn't leak the ambient `Bun` global into consumers' `.d.ts` resolution.
- **SSEContext** _(interface)_ — `interface SSEContext`
  Minimal context shape `sse` needs — the live request, for its client-disconnect signal.
- **SSEInit** _(interface)_ — `interface SSEInit`
- **SSEMessage** _(interface)_ — `interface SSEMessage`
  One SSE frame. Every field is optional; `data` may be multi-line (emitted as multiple `data:` lines).
- **SSEStream** _(interface)_ — `interface SSEStream`
  The stream handed to the `run` callback.
- **ScheduledController** _(interface)_ — `interface ScheduledController`
  A Cloudflare Workers-style scheduled (cron) controller. Structural — no Workers type dependency.
- **ScheduledHandler** _(type)_ — `type ScheduledHandler<Env = unknown> = ( controller: ScheduledController, context: { readonly env: Env; waitUntil(promise: Promise<unknown>): void }, ) => MaybePromise<void>`
  A nifra cron handler: the platform controller + the same typed `env`/`waitUntil` nifra threads into request handlers. Schedule background work with `waitUntil` so it outlives the trigger.
- **Server** _(class)_ — `class Server<R extends Registry = EmptyRegistry, Ctx = EmptyContext>`
  The inline server. Routes are chainable and fully type-inferred. `derive`/ `decorate` extend the handler context (`Ctx`) for routes defined *after* them, with full types; `Ctx` is server-only and never touches the client registry.
- **ServerOptions** _(interface)_ — `interface ServerOptions`
- **StandardIssue** _(interface)_ — `interface StandardIssue`
- **StandardResult** _(type)_ — `type StandardResult<Output> = StandardSuccess<Output> | StandardFailure`
- **StandardSchemaV1** _(interface)_ — `interface StandardSchemaV1<Input = unknown, Output = Input>`
  The Standard Schema v1 interface (https://standardschema.dev), vendored as types + a tiny runtime helper so any compliant validator — zod, valibot, arktype, … — validates requests without coupling the framework to one lib. The spec is MIT-licensed and explicitly designed to be copied.
- **StandardTypes** _(interface)_ — `interface StandardTypes<Input = unknown, Output = Input>`
- **StandardWebSocket** _(interface)_ — `interface StandardWebSocket`
  A standard server-side `WebSocket` — the half returned by Deno's `Deno.upgradeWebSocket` and the Workers `WebSocketPair`. {@link attachWebSocket} wires one to a nifra handler, so the Deno and Workers bridges share all the dispatch/normalization/error-isolation logic (only the upgrade call differs).
- **ToolAnnotations** _(interface)_ — `interface ToolAnnotations`
  MCP tool safety hints, surfaced in `tools/list`, that tell an agent how risky a `.tool()` call is - so it can decide whether to auto-invoke or confirm first. All optional; an omitted hint means "unknown". Mirrors the MCP spec's tool `annotations`.
- **TypedSSEStream** _(interface)_ — `interface TypedSSEStream<Event>`
  The stream handed to an `app.sse()` handler: `send` takes the route's TYPED event payload and serializes it (JSON) into the SSE `data:` field — the compile-time half of the `sse` contract.
- **VERSION** _(const)_ — `VERSION: "1.13.0"`
  Current package version. A hardcoded literal on purpose — core runs on the edge (no fs), so it can't read its own package.json at runtime. `scripts/version.ts` rewrites it on every release bump and `check:publish` asserts it equals `@nifrajs/core`'s package version.
- **ValidationOutcome** _(type)_ — `type ValidationOutcome<Output> = | { readonly ok: true; readonly value: Output } | { readonly ok: false; readonly issues: ReadonlyArray<StandardIssue> }`
- **Version** _(type)_ — `type Version = typeof VERSION`
- **WebSocketContext** _(interface)_ — `interface WebSocketContext<Env = unknown>`
  The request-context subset the `upgrade()` guard sees — the same lazy accessors a route handler's `c` has (cookies/headers/env are read straight off the upgrade request). Structurally a slice of the core `RawContext`, so the real context object satisfies it.
- **WebSocketData** _(type)_ — `type WebSocketData = string | Uint8Array`
  A received frame, normalized across runtimes: text → `string`, binary → `Uint8Array`.
- **WebSocketHandler** _(interface)_ — `interface WebSocketHandler<Data = unknown, Env = unknown, Schema extends StandardSchemaV1 | undefined = undefined, Send extends StandardSchemaV1 | undefined = undefined>`
  A WebSocket route's lifecycle. All callbacks optional; only `message` is needed for an echo.
- **WebSocketUpgradeOutcome** _(type)_ — `type WebSocketUpgradeOutcome`
  The outcome of `app.resolveWebSocketUpgrade(req)` — for serving adapters: - `pass` — not a WS upgrade for a registered WS route; handle as a normal HTTP request. - `reject` — a WS route matched but `upgrade()` rejected (or the path was malformed); return `response`. - `upgrade` — perform the runtim…
- **commonSecretPatterns** _(const)_ — `commonSecretPatterns: readonly RegExp[]`
  A conservative, high-signal set of patterns for {@link RedactOptions.valuePatterns} — opt in by passing it (or a subset) to `jsonLogger`/`redactLogFields`. Covers bearer tokens, JWTs, emails, and a few well-known key formats (Stripe, GitHub, AWS access-key ids). Chosen to minimize false positives; …
- **defineIdentityPlugin** _(function)_ — `defineIdentityPlugin: (name: string, apply: <S extends AnyServer>(app: S) => S) => IdentityPlugin`
  Define a type-**identity** plugin: it registers routes/hooks as a side effect but returns the app with its `Registry` + `Context` UNCHANGED. Use this (not {@link definePlugin}) for any plugin that doesn't add context types - e.g. one mounting an auth handler. It threads the caller's *concrete* serv…
- **definePlugin** _(function)_ — `definePlugin: <In extends AnyServer, Out extends AnyServer>(name: string, apply: (app: In) => Out) => NifraPlugin<In, Out>`
  Name + ergonomics for a plugin that **adds typed context** (`derive`/`decorate`). `app.use(myPlugin)` applies it once; a second `use` of the same name is skipped (idempotent), so plugins can depend on each other without double-registering hooks.
- **defineRouterPlugin** _(const)_ — `defineRouterPlugin: (name: string, apply: <S extends AnyServer>(app: S) => S) => IdentityPlugin`
  Alias of {@link defineIdentityPlugin} with a name that says what it's FOR: a plugin that **mounts routes/hooks but adds no context type** (an auth router, an audit logger). Use this - not {@link definePlugin} - for any such plugin, or the typed client silently collapses to `any`. The "identity" in …
- **jsonLogger** _(function)_ — `jsonLogger: (write?: (line: string) => void, options?: RedactOptions) => Logger`
  The default logger: one redacted JSON object per line. `write` is injectable for tests or alternative sinks (defaults to stderr). `options` tunes redaction — pass `valuePatterns` (e.g. {@link commonSecretPatterns}) to also scrub secrets embedded in values + the message. Framework keys (`level`, `me…
- **parseCookies** _(function)_ — `parseCookies: (header: string | null | undefined) => Record<string, string>`
  Parse a request `Cookie` header into a name→value map (values URL-decoded). Unparseable pairs are skipped rather than throwing — a junk `Cookie` header shouldn't fail the request.
- **redactLogFields** _(function)_ — `redactLogFields: (fields: LogFields, options?: RedactOptions) => LogFields`
  Deep-copy `fields`, replacing values under sensitive keys with the placeholder; cycle-safe. With `options.valuePatterns`, also scans string values for those patterns (opt-in). Without options, this is pure key-name redaction (the long-standing default).
- **serializeCookie** _(function)_ — `serializeCookie: (name: string, value: string, options?: CookieOptions) => string`
  Serialize a `Set-Cookie` header value. Pure — applies **no** security defaults (the caller, e.g. `c.set.cookie`, layers `HttpOnly`/`Secure`/`SameSite` on). Throws on an invalid cookie name, a header-injecting `Path`/`Domain`, a non-integer `maxAge`, or an oversized result — a serialization bug shou…
- **server** _(function)_ — `server: <Env = unknown>(options?: ServerOptions) => Server<EmptyRegistry, { readonly env: Env; }>`
  Create a new {@link Server}. Pass an `Env` to type the platform bindings — `server<Env>()` makes `c.env: Env` in every handler + middleware, and types the `env` argument of `app.fetch` / `toFetchHandler`. Omit it and `c.env` is `unknown` (validate/cast before use).
- **signValue** _(function)_ — `signValue: (value: string, secret: string) => Promise<string>`
  Append an HMAC-SHA256 signature to a value → `value.signature` (base64url). For signed cookies.
- **silentLogger** _(const)_ — `silentLogger: Logger`
  Discards everything — for tests, or when log output is handled elsewhere.
- **toFetchHandler** _(function)_ — `toFetchHandler: <Env = unknown>(app: { fetch(request: Request, platform?: Platform<Env>): MaybePromise<Response>; resolveWebSocketUpgrade?(request: Request, platform?: Platform<Env>): MaybePromise<WebSocketUpgradeOutcom…`
- **unsignValue** _(function)_ — `unsignValue: (signed: string, secret: string) => Promise<string | null>`
  Verify a `value.signature` produced by {@link signValue} and return the value, or `null` if the signature is missing, malformed, or doesn't match. Verification is **constant-time** (`crypto.subtle.verify`), so a wrong signature can't be discovered byte-by-byte via timing.
