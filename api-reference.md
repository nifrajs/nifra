# nifra API reference (generated)

Every public export of every package — name, kind, signature, and doc summary — extracted from each `src/index.ts` with the TypeScript compiler API, so it cannot drift from the code. For HTTP route shapes (request/response bodies), see the OpenAPI + Scalar reference your app serves at `/reference`. For prose guides, see `llms-full.txt`.

## @nifrajs/agent-telemetry

- **AgentSpan** _(type)_ — `type AgentSpan = NifraSpan`
  A tool-call span. Kept as an alias for package-specific naming without duplicating OTel types.
- **AgentSpanExporter** _(type)_ — `type AgentSpanExporter = SpanExporter`
  Exporter seam shared with `@nifrajs/otel`.
- **AgentTelemetryOptions** _(interface)_ — `interface AgentTelemetryOptions`
- **agentTelemetry** _(function)_ — `agentTelemetry: (options: AgentTelemetryOptions) => { name: string; beforeHandle(context: HookContext): undefined; onError(error: unknown, context: HookContext): undefined; onResponse(response: Response, request: Reques…`
  Agent telemetry middleware. Register via `app.use(agentTelemetry({ exporter }))`.
- **consoleAgentExporter** _(function)_ — `consoleAgentExporter: (log?: (line: string) => void) => AgentSpanExporter`
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

- **BetterAuthLike** _(interface)_ — `interface BetterAuthLike`
  The structural slice of a [better-auth](https://better-auth.com) instance this package needs. Declared structurally rather than imported, so `@nifrajs/better-auth` has **no runtime dependency** on better-auth: you pass your own `auth` object and its concrete types flow through {@link getSession} / …
- **BetterAuthOptions** _(interface)_ — `interface BetterAuthOptions`
- **RequireSessionOptions** _(interface)_ — `interface RequireSessionOptions`
  What {@link requireSession} does on a missing session: `302` to `redirectTo` (a same-origin path), or — when omitted — a `401` JSON (`{ ok: false, error: "unauthorized" }`). Mirrors `@nifrajs/auth` guards.
- **SessionOf** _(type)_ — `type SessionOf<A extends BetterAuthLike> = NonNullable< Awaited<ReturnType<A["api"]["getSession"]>> >`
  The non-null session payload of a concrete better-auth instance `A`, inferred from its `api.getSession` return type (typically `{ user: User; session: Session }`).
- **betterAuth** _(function)_ — `betterAuth: (auth: BetterAuthLike, options?: BetterAuthOptions) => import("@nifrajs/core").IdentityPlugin`
  Mount a better-auth instance into a nifra app: registers its handler at `${basePath}/*` (default `/api/auth/*`) for `GET` + `POST`, so every better-auth endpoint — sign-in/up/out, OAuth callbacks, session, 2FA, magic links, … — is served by your nifra server.
- **getSession** _(function)_ — `getSession: <A extends BetterAuthLike>(auth: A, request: Request) => Promise<SessionOf<A> | null>`
  Resolve the better-auth session for a request — a thin, typed wrapper over `auth.api.getSession`. Returns `null` when unauthenticated. Takes the raw `Request` so it works in both server handlers (`c.req`) and web loaders/actions (`request`).
- **requireSession** _(function)_ — `requireSession: <A extends BetterAuthLike>(auth: A, request: Request, options?: RequireSessionOptions) => Promise<SessionOf<A>>`
  Require an authenticated better-auth session at the top of a protected handler/loader/action. Returns the (non-null) session when present; otherwise **throws a `Response`** (302/401) — nifra returns a thrown `Response` as-is, short-circuiting the rest of the handler.

## @nifrajs/budget

- **BudgetClock** _(interface)_ — `interface BudgetClock`
  The only clocks deadline mechanics need. Inject both for deterministic tests.
- **CreateRequestBudgetOptions** _(interface)_ — `interface CreateRequestBudgetOptions`
- **DeadlineAdmission** _(type)_ — `type DeadlineAdmission`
- **DeadlineAdmissionOptions** _(interface)_ — `interface DeadlineAdmissionOptions`
- **DeadlineExceededError** _(class)_ — `class DeadlineExceededError`
- **DeadlineHeaderResult** _(type)_ — `type DeadlineHeaderResult = | { readonly ok: true; readonly deadline: number } | { readonly ok: false; readonly reason: "missing" | "malformed" }`
- **DeadlineHeadersInit** _(type)_ — `type DeadlineHeadersInit = | Headers | Readonly<Record<string, string>> | string[][] | undefined`
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
- **FetchFn** _(type)_ — `type FetchFn = (input: string, init?: RequestInit) => Promise<Response>`
  The fetch shape the client needs — looser than `typeof fetch` so an in-process bridge or a test mock satisfies it without the extra members (`.preconnect`, overloads) of the global.
- **Jsonify** _(type)_ — `type Jsonify<T>`
  Maps a value to the shape it takes after a JSON round-trip, so the client's `data` type reflects the wire — not the handler's in-memory return.
- **LoaderArgs** _(interface)_ — `interface LoaderArgs<Api, Env = unknown>`
  Context a route `loader` receives: the route params, the request, a typed in-process `api` (an {@link ApiProxy} for the app contract `Api`), and the platform `env`. Pair with `inProcessClient`.
- **LoaderData** _(type)_ — `type LoaderData<L> = L extends (...args: never[]) => infer R ? Awaited<R> : never`
  The (awaited) return of a `loader`, for typing a page component's `data` prop.
- **RegistryOf** _(type)_ — `type RegistryOf<App> = App extends Server<infer R, infer _Ctx> ? R : never`
  Extract the accumulated route registry from a server's type (`typeof app`), ignoring its middleware context.
- **Result** _(type)_ — `type Result<Data, ErrData = unknown> = | { readonly ok: true; readonly status: number; readonly data: Data; readonly error: null } | { readonly ok: false readonly status: number readonly data: ErrData readonly error: Ap…`
  The outcome of a client call. The client never throws — inspect `ok` to branch. `data` is the parsed response body, **typed by `ok`**: on success it's the route's response type; on failure it's the parsed error body, typed from the route's `errors` contract (`unknown` when the route declares none, …
- **SubscribeOptions** _(interface)_ — `interface SubscribeOptions<I extends RouteInfo>`
- **Subscription** _(interface)_ — `interface Subscription`
- **Treaty** _(type)_ — `type Treaty<App> = TreatyFromRegistry<RegistryOf<App>>`
  The Eden-style proxy type for a server. Use a named alias for readable errors:
- **TreatyFromRegistry** _(type)_ — `type TreatyFromRegistry<R> = TreatyNode<R, ""> & RootIndex<R>`
  The Eden-style proxy type for a route registry — the shared core used by both `Treaty<App>` (coupled, from `typeof app`) and `client(contract, url)` (decoupled, from a contract's `RegistryFor`).
- **client** _(function)_ — `client: { <App>(baseUrl: string, options?: ClientOptions): Treaty<App>; <const C extends ContractShape>(contract: C, baseUrl: string, options?: ClientOptions): TreatyFromRegistry<RegistryFor<C>>; }`
  Create an end-to-end-typed client for a nifra server. Two modes:
- **inProcessClient** _(function)_ — `inProcessClient: <App extends { fetch(request: Request): Response | Promise<Response>; }>(app: App, options?: Omit<ClientOptions, "fetch">) => Treaty<App>`
  A {@link client} whose `fetch` calls a nifra app's own `fetch` in-process — no network, full lifecycle (validation, middleware, contracts). For SSR loaders. Typed from `App` exactly like the network client. The `(url, init) → Request` bridge is required because the client calls `fetch(url, init)` w…
- **testClient** _(const)_ — `testClient: <App extends { fetch(request: Request): Response | Promise<Response>; }>(app: App, options?: Omit<ClientOptions, "fetch">) => Treaty<App>`
  The in-process test client — the Fastify-`inject` / supertest equivalent for nifra. Drives the app's own `fetch` directly: no server, no port, no network, the full real lifecycle (validation, middleware, contracts, auth), and end-to-end types from `App`. Calls never throw — branch on `res.ok`. An a…

## @nifrajs/content

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

## @nifrajs/core

- **AnyServer** _(type)_ — `type AnyServer = Server<any, any>`
- **AssuranceConfig** _(interface)_ — `interface AssuranceConfig`
- **AssuranceDeclaration** _(interface)_ — `interface AssuranceDeclaration`
  Metadata installed on a middleware/plugin by {@link withRouteAssurance}.
- **AssuranceEvidence** _(interface)_ — `interface AssuranceEvidence`
  Reflection-safe proof that a named enforcement module covered a route.
- **AssuranceFinding** _(interface)_ — `interface AssuranceFinding`
- **AssuranceFindingCode** _(type)_ — `type AssuranceFindingCode = | "no-routes" | "unclassified-route" | "missing-evidence" | "forbidden-evidence"`
- **AssurancePolicy** _(interface)_ — `interface AssurancePolicy`
- **AssuranceReport** _(interface)_ — `interface AssuranceReport`
- **AssuranceRouteSelector** _(interface)_ — `interface AssuranceRouteSelector`
- **AssuranceRule** _(interface)_ — `interface AssuranceRule`
- **AssuranceScope** _(type)_ — `type AssuranceScope = "global" | "subsequent" | "plugin"`
  Where enforcement evidence follows Nifra's route-registration semantics.
- **AssuredRoute** _(interface)_ — `interface AssuredRoute`
- **Context** _(interface)_ — `interface Context<Path extends string = string, S extends RouteSchema = RouteSchema>`
  Handler context. `params` are inferred from the path; `body` and `query` are the validated outputs of their schemas when declared (else `undefined` / raw `URLSearchParams`).
- **ContextForOp** _(type)_ — `type ContextForOp<O extends OperationDef> = Context<O["path"], SchemaForOp<O> & RouteSchema>`
  The handler context for an op — identical to the inline `Context<Path, S>`, so a handler written for an inline route type-checks unchanged under `implement` (the graduation guarantee).
- **ContractShape** _(type)_ — `type ContractShape = Record<string, OperationDef>`
  A contract: named operations. Names are the handler keys and OpenAPI operationIds.
- **CookieOptions** _(interface)_ — `interface CookieOptions`
  Attributes for a `Set-Cookie`. `expires` is a `Date`; `maxAge` is in **seconds**.
- **DiffSeverity** _(type)_ — `type DiffSeverity = "breaking" | "compatible" | "info"`
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
- **HandlersFor** _(type)_ — `type HandlersFor<C extends ContractShape> = { [K in keyof C]: (context: ContextForOp<C[K]>) => MaybePromise<HandlerReturnForOp<C[K]>> }`
  The handlers `implement` requires: one per operation, typed from the op's input + response contract.
- **IdentityPlugin** _(type)_ — `type IdentityPlugin = (<S extends AnyServer>(app: S) => S) & { readonly pluginName?: string }`
  A named type-identity plugin built with {@link defineIdentityPlugin}. It returns the same concrete server type it receives, preserving the caller's typed registry and context across `.use()` while still allowing the plugin to register runtime hooks or handlers.
- **InferInput** _(type)_ — `type InferInput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["input"]`
- **InferOutput** _(type)_ — `type InferOutput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["output"]`
- **JsonSchema** _(type)_ — `type JsonSchema = boolean | Readonly<Record<string, unknown>>`
  JSON Schema permits either a schema object or the boolean schemas `true` and `false`.
- **LogFields** _(type)_ — `type LogFields = Record<string, unknown>`
  Structured, redacting logger. The framework logs through this interface so secrets/PII are scrubbed once, centrally (per the project's logging rule), not at each call site. Bring your own by passing `logger` to `server()`.
- **Logger** _(interface)_ — `interface Logger`
- **METHODS** _(const)_ — `METHODS: readonly ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]`
  HTTP methods the router accepts.
- **McpPromptDescriptor** _(interface)_ — `interface McpPromptDescriptor`
  An app-declared MCP prompt — a reusable prompt template an agent can fetch through `nifra mcp`.
- **McpResourceDescriptor** _(interface)_ — `interface McpResourceDescriptor`
  An app-declared MCP resource — read-only data an agent can fetch through `nifra mcp`.
- **Method** _(type)_ — `type Method = (typeof METHODS)[number]`
- **Middleware** _(interface)_ — `interface Middleware`
  A bundle of lifecycle hooks applied together via {@link Server.use} — the unit `@nifrajs/middleware` ships (cors, security headers, rate-limit). Every hook is optional and wired to its lifecycle point. Middleware is context-agnostic (sees the base `Context`); `use` does no context-type merging — th…
- **NIFRA_ASSURANCE** _(const)_ — `NIFRA_ASSURANCE: Readonly<{ readonly AUTHENTICATED: "nifra.authenticated"; readonly BODY_BOUNDED: "nifra.body-bounded"; readonly CSRF: "nifra.csrf"; readonly IDEMPOTENCY_KEY: "nifra.idempotency-key"; readonly IP_RESTRIC…`
  Canonical evidence ids emitted by Nifra's official middleware modules.
- **NifraPlugin** _(type)_ — `type NifraPlugin<In extends AnyServer = AnyServer, Out extends AnyServer = In> = (( app: In, ) => Out) & { readonly pluginName?: string }`
  A nifra **plugin**: a function that augments an app — calling `use`/`derive`/`decorate` and/or registering routes — and returns it. Because `derive`/`decorate` are type-threaded, an **inline** `app.use((a) => a.derive(...).decorate(...))` carries the added context to handlers defined after it (the …
- **NifraWebSocket** _(interface)_ — `interface NifraWebSocket<Data = unknown>`
  The portable socket handed to WS lifecycle callbacks. Each adapter wraps its native socket.
- **NodeServeOutcome** _(type)_ — `type NodeServeOutcome`
  What {@link Server.resolveNode} returns: either a plain-data render the `@nifrajs/node` adapter writes to the socket directly (`kind: "json"` — status + headers + cookies + a pre-stringified body, **no** undici `Response` built or drained), a marked buffered response body (`kind: "body"` — e.g.
- **OnRequestResult** _(type)_ — `type OnRequestResult = Response | Request | undefined`
- **OperationDef** _(interface)_ — `interface OperationDef`
  One operation in a contract. Input schemas are any Standard Schema; `response` is optional.
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
- **ReflectedRoute** _(interface)_ — `interface ReflectedRoute`
- **ReflectedRouteSchema** _(interface)_ — `interface ReflectedRouteSchema`
- **ReflectedSchemaField** _(interface)_ — `interface ReflectedSchemaField`
  One top-level property of an introspectable object schema.
- **Registry** _(type)_ — `type Registry = Record<string, Record<string, RouteInfo>>`
  The accumulated, type-level map of every route on a Server: path → method → RouteInfo.
- **RegistryFor** _(type)_ — `type RegistryFor<C extends ContractShape> = { [P in C[keyof C]["path"]]: { [K in keyof C as C[K]["path"] extends P ? C[K]["method"] : never]: RouteInfoForOp<C[K]> } }`
  Re-key the name-keyed ops into the `path → method → RouteInfo` registry.
- **RegistryFromImpl** _(type)_ — `type RegistryFromImpl<C extends ContractShape, H extends HandlersFor<C>>`
  The registry produced by `implement`: input from the contract op; `output` is the declared `response` contract when present (it wins — exactly as in the inline path), else the bound HANDLER's return — so the implemented server stays route-for-route identical to the equivalent inline server (the mod…
- **ResponseControls** _(interface)_ — `interface ResponseControls`
  Mutable response controls a handler may write to before returning.
- **ResponseDef** _(interface)_ — `interface ResponseDef`
  An additional (non-success) response a contract operation can document, e.g. a `404`.
- **ResponseFinalization** _(interface)_ — `interface ResponseFinalization`
  The terminal response-pipeline outcome observed after every transforming `onResponse` hook.
- **RobotsOptions** _(interface)_ — `interface RobotsOptions`
- **RobotsRule** _(interface)_ — `interface RobotsRule`
- **RouteChange** _(interface)_ — `interface RouteChange`
- **RouteConfigError** _(class)_ — `class RouteConfigError`
  Thrown at route registration when a route is misconfigured. This is the boot-time rejection layer: loud and early, never deferred to the first request.
- **RouteConfigErrorCode** _(type)_ — `type RouteConfigErrorCode = | "DUPLICATE_ROUTE" | "DUPLICATE_PARAM" | "PARAM_NAME_CONFLICT" | "INVALID_PATH" | "INVALID_PARAM_NAME" | "WILDCARD_NOT_LAST" | "INVALID_METHOD"`
  Stable codes for boot-time (L2) route configuration failures.
- **RouteDescriptor** _(interface)_ — `interface RouteDescriptor`
  A registered route's public descriptor — method, path, and input schemas. The router trie discards the original patterns, so this flat list is what lets tools (e.g. `toOpenAPI`) enumerate routes after registration.
- **RouteInfo** _(interface)_ — `interface RouteInfo`
  One route's input/output shape as the **client** will consume it. `query`/`body` are `never` when the route declares no schema for them, so the client can detect "this route takes no body" via `[body] extends [never]`. `output` is the handler's raw return type (the client applies `Jsonify` when rea…
- **RouteSchema** _(interface)_ — `interface RouteSchema`
  Per-route input schemas. Each is any Standard Schema (zod/valibot/arktype/…).
- **RouteSnapshot** _(interface)_ — `interface RouteSnapshot`
  One route in a snapshot — plain JSON, safe to persist as a CI baseline.
- **RouteSnapshotSchema** _(interface)_ — `interface RouteSnapshotSchema`
- **Router** _(class)_ — `class Router<T>`
  Radix-style segment trie router. Matching precedence is static > param > wildcard. Parameter/wildcard values are returned RAW (not percent-decoded); the server boundary decodes and rejects malformed encodings with a 400, keeping this layer pure and allocation-light.
- **RouterMatch** _(type)_ — `type RouterMatch<T>`
  Result of {@link Router.find}. The `found: false` cases deliberately separate a missing path (404) from a path that exists for other methods (405), so the server layer can answer correctly and populate an `Allow` header.
- **RoutesDiff** _(interface)_ — `interface RoutesDiff`
- **RunningServer** _(interface)_ — `interface RunningServer`
  The handle `listen()` returns — the slice of Bun's server nifra holds and exposes. Declared explicitly (rather than `ReturnType<typeof Bun.serve>`) so the public type surface doesn't leak the ambient `Bun` global into consumers' `.d.ts` resolution.
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
- **SchemaReflection** _(interface)_ — `interface SchemaReflection`
  Validation and introspection capabilities discovered for one schema-like value.
- **SchemaSnapshot** _(interface)_ — `interface SchemaSnapshot`
  One schema position in a snapshot: JSON Schema metadata only, no validator.
- **Server** _(class)_ — `class Server<R extends Registry = EmptyRegistry, Ctx = EmptyContext>`
  The inline server. Routes are chainable and fully type-inferred. `derive`/ `decorate` extend the handler context (`Ctx`) for routes defined *after* them, with full types; `Ctx` is server-only and never touches the client registry.
- **ServerOptions** _(interface)_ — `interface ServerOptions`
- **SignatureEncoding** _(type)_ — `type SignatureEncoding = "hex" | "base64"`
- **SitemapChangeFreq** _(type)_ — `type SitemapChangeFreq = | "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never"`
- **SitemapEntry** _(interface)_ — `interface SitemapEntry`
- **SitemapOptions** _(interface)_ — `interface SitemapOptions`
- **StandardIssue** _(interface)_ — `interface StandardIssue`
- **StandardResult** _(type)_ — `type StandardResult<Output> = StandardSuccess<Output> | StandardFailure`
- **StandardSchemaV1** _(interface)_ — `interface StandardSchemaV1<Input = unknown, Output = Input>`
  The Standard Schema v1 interface (https://standardschema.dev), vendored as types + a tiny runtime helper so any compliant validator — zod, valibot, arktype, … — validates requests without coupling the framework to one lib. The spec is MIT-licensed and explicitly designed to be copied.
- **StandardTypes** _(interface)_ — `interface StandardTypes<Input = unknown, Output = Input>`
- **StandardWebSocket** _(interface)_ — `interface StandardWebSocket`
  A standard server-side `WebSocket` — the half returned by Deno's `Deno.upgradeWebSocket` and the Workers `WebSocketPair`. {@link attachWebSocket} wires one to a nifra handler, so the Deno and Workers bridges share all the dispatch/normalization/error-isolation logic (only the upgrade call differs).
- **ToolAnnotations** _(interface)_ — `interface ToolAnnotations`
  MCP tool safety hints, surfaced in `tools/list`, that tell an agent how risky a `.tool()` call is — so it can decide whether to auto-invoke or confirm first. All optional; an omitted hint means "unknown". Mirrors the MCP spec's tool `annotations`.
- **TopicRegistry** _(class)_ — `class TopicRegistry`
  In-process pub/sub for `ws.subscribe(topic)` + `app.publish(topic, data)`. **Single-instance only** — topics live in this process's memory, so a multi-instance deploy (multiple servers behind a load balancer) needs an external fan-out (Redis pub/sub, a Cloudflare Durable Object, NATS, …) bridged to…
- **TypedSSEStream** _(interface)_ — `interface TypedSSEStream<Event>`
  The stream handed to an `app.sse()` handler: `send` takes the route's TYPED event payload and serializes it (JSON) into the SSE `data:` field — the compile-time half of the `sse` contract.
- **VERSION** _(const)_ — `VERSION: "1.8.0"`
  Current package version. A hardcoded literal on purpose — core runs on the edge (no fs), so it can't read its own package.json at runtime. `scripts/version.ts` rewrites it on every release bump and `check:publish` asserts it equals `@nifrajs/core`'s package version, so the literal can't go stale (i…
- **ValidationOutcome** _(type)_ — `type ValidationOutcome<Output> = | { readonly ok: true; readonly value: Output } | { readonly ok: false; readonly issues: ReadonlyArray<StandardIssue> }`
- **VerifyWebhookOptions** _(interface)_ — `interface VerifyWebhookOptions`
- **Version** _(type)_ — `type Version = typeof VERSION`
- **WebSocketContext** _(interface)_ — `interface WebSocketContext<Env = unknown>`
  The request-context subset the `upgrade()` guard sees — the same lazy accessors a route handler's `c` has (cookies/headers/env are read straight off the upgrade request). Structurally a slice of the core `RawContext`, so the real context object satisfies it.
- **WebSocketData** _(type)_ — `type WebSocketData = string | Uint8Array`
  A received frame, normalized across runtimes: text → `string`, binary → `Uint8Array`.
- **WebSocketHandler** _(interface)_ — `interface WebSocketHandler<Data = unknown, Env = unknown, Schema extends StandardSchemaV1 | undefined = undefined>`
  A WebSocket route's lifecycle. All callbacks optional; only `message` is needed for an echo.
- **WebSocketUpgradeOutcome** _(type)_ — `type WebSocketUpgradeOutcome`
  The outcome of `app.resolveWebSocketUpgrade(req)` — for serving adapters: - `pass` — not a WS upgrade for a registered WS route; handle as a normal HTTP request. - `reject` — a WS route matched but `upgrade()` rejected (or the path was malformed); return `response`. - `upgrade` — perform the runtim…
- **WebhookFailureReason** _(type)_ — `type WebhookFailureReason = | "missing_signature" | "invalid_signature" | "timestamp_out_of_tolerance" | "malformed_signature" | "payload_too_large" | "invalid_content_length"`
- **WebhookProvider** _(type)_ — `type WebhookProvider = "stripe" | "github" | "generic"`
- **WebhookResult** _(type)_ — `type WebhookResult = | { readonly ok: true; readonly payload: string } | { readonly ok: false; readonly reason: WebhookFailureReason }`
  Verified ⇒ the raw `payload` text (parse it with your schema). Rejected ⇒ a stable `reason`.
- **attachWebSocket** _(function)_ — `attachWebSocket: (socket: StandardWebSocket, handler: WebSocketHandler, data: unknown, options: { openNow: boolean; pubsub: TopicRegistry; }) => NifraWebSocket`
  Wire a standard server-side `WebSocket` to a nifra {@link WebSocketHandler}, returning the portable {@link NifraWebSocket}. Shared by the Deno and Workers bridges. `openNow` fires `open` immediately (Workers, where the socket is already open after `accept()`); otherwise `open` waits for the socket'…
- **commonSecretPatterns** _(const)_ — `commonSecretPatterns: readonly RegExp[]`
  A conservative, high-signal set of patterns for {@link RedactOptions.valuePatterns} — opt in by passing it (or a subset) to `jsonLogger`/`redactLogFields`. Covers bearer tokens, JWTs, emails, and a few well-known key formats (Stripe, GitHub, AWS access-key ids). Chosen to minimize false positives; …
- **defineAssuranceConfig** _(function)_ — `defineAssuranceConfig: (config: AssuranceConfig) => AssuranceConfig`
  Identity helper for a `nifra.assurance.ts` default export.
- **defineAssurancePolicy** _(function)_ — `defineAssurancePolicy: (policy: AssurancePolicy) => AssurancePolicy`
  Validate and freeze an ordered assurance policy.
- **defineContract** _(function)_ — `defineContract: <const C extends ContractShape>(contract: C) => C`
  Define a standalone, versionable contract. Identity at runtime (it returns the contract for type inference via the `const` type parameter, which preserves the path/method literals) plus boot-time (L2) validation: each operation must use a known method, a path starting with `/`, and no two operation…
- **defineIdentityPlugin** _(function)_ — `defineIdentityPlugin: (name: string, apply: <S extends AnyServer>(app: S) => S) => IdentityPlugin`
  Define a type-**identity** plugin: it registers routes/hooks as a side effect but returns the app with its `Registry` + `Context` UNCHANGED. Use this (not {@link definePlugin}) for any plugin that doesn't add context types — e.g. one mounting an auth handler. It threads the caller's *concrete* serv…
- **definePlugin** _(function)_ — `definePlugin: <In extends AnyServer, Out extends AnyServer>(name: string, apply: (app: In) => Out) => NifraPlugin<In, Out>`
  Name + ergonomics for a plugin that **adds typed context** (`derive`/`decorate`). `app.use(myPlugin)` applies it once; a second `use` of the same name is skipped (idempotent), so plugins can depend on each other without double-registering hooks.
- **defineRouterPlugin** _(const)_ — `defineRouterPlugin: (name: string, apply: <S extends AnyServer>(app: S) => S) => IdentityPlugin`
  Alias of {@link defineIdentityPlugin} with a name that says what it's FOR: a plugin that **mounts routes/hooks but adds no context type** (an auth router, an audit logger). Use this — not {@link definePlugin} — for any such plugin, or the typed client silently collapses to `any`. The "identity" in …
- **diffRouteSnapshots** _(function)_ — `diffRouteSnapshots: (before: readonly RouteSnapshot[], after: readonly RouteSnapshot[]) => RoutesDiff`
  Diff two route snapshots (`snapshotRoutes` output, possibly restored from JSON). Every change is classified breaking/compatible/info; `hasBreaking` is the CI-gate bit.
- **evaluateRouteAssurance** _(function)_ — `evaluateRouteAssurance: (source: unknown, policyInput: AssurancePolicy) => AssuranceReport`
  Evaluate reflected route evidence against the first matching policy rule.
- **implement** _(function)_ — `implement: <const C extends ContractShape, H extends HandlersFor<C>>(contract: C, handlers: H) => Server<RegistryFromImpl<C, H>>`
  Bind handlers to a contract, producing a real {@link Server} you can `.listen()` or `.fetch()`. Each op is registered through the same path as the inline builder, so the result is identical to writing the routes inline — handlers lift over **unchanged** ("graduation"), and body/query schemas valida…
- **jsonLogger** _(function)_ — `jsonLogger: (write?: (line: string) => void, options?: RedactOptions) => Logger`
  The default logger: one redacted JSON object per line. `write` is injectable for tests or alternative sinks (defaults to stderr). `options` tunes redaction — pass `valuePatterns` (e.g. {@link commonSecretPatterns}) to also scrub secrets embedded in values + the message. Framework keys (`level`, `me…
- **matchesAssuranceSelector** _(function)_ — `matchesAssuranceSelector: (route: Pick<ReflectedRoute, "method" | "path" | "tool">, selector: AssuranceRouteSelector) => boolean`
  Shared selector semantics for policy rules and framework adapters.
- **parseCookies** _(function)_ — `parseCookies: (header: string | null | undefined) => Record<string, string>`
  Parse a request `Cookie` header into a name→value map (values URL-decoded). Unparseable pairs are skipped rather than throwing — a junk `Cookie` header shouldn't fail the request.
- **redactLogFields** _(function)_ — `redactLogFields: (fields: LogFields, options?: RedactOptions) => LogFields`
  Deep-copy `fields`, replacing values under sensitive keys with the placeholder; cycle-safe. With `options.valuePatterns`, also scans string values for those patterns (opt-in). Without options, this is pure key-name redaction (the long-standing default).
- **reflectRoutes** _(function)_ — `reflectRoutes: (source: unknown) => readonly ReflectedRoute[]`
  Safely enumerate and normalize route descriptors from an app or descriptor array. Invalid entries are ignored; a missing/throwing `routes()` method yields an empty array.
- **reflectSchema** _(function)_ — `reflectSchema: (value: unknown) => SchemaReflection`
  Reflect a Standard Schema, Nifra/TypeBox schema carrier, or raw JSON Schema. Never throws. Validation-only schemas have `standard` but no `jsonSchema`; raw JSON Schema has the reverse.
- **robots** _(function)_ — `robots: (options: RobotsOptions) => string`
  Build a `robots.txt` body from grouped rules plus optional `Sitemap:`/`Host:` lines.
- **serializeCookie** _(function)_ — `serializeCookie: (name: string, value: string, options?: CookieOptions) => string`
  Serialize a `Set-Cookie` header value. Pure — applies **no** security defaults (the caller, e.g. `c.set.cookie`, layers `HttpOnly`/`Secure`/`SameSite` on). Throws on an invalid cookie name, a header-injecting `Path`/`Domain`, a non-integer `maxAge`, or an oversized result — a serialization bug shou…
- **server** _(function)_ — `server: <Env = unknown>(options?: ServerOptions) => Server<EmptyRegistry, { readonly env: Env; }>`
  Create a new {@link Server}. Pass an `Env` to type the platform bindings — `server<Env>()` makes `c.env: Env` in every handler + middleware, and types the `env` argument of `app.fetch` / `toFetchHandler`. Omit it and `c.env` is `unknown` (validate/cast before use).
- **signValue** _(function)_ — `signValue: (value: string, secret: string) => Promise<string>`
  Append an HMAC-SHA256 signature to a value → `value.signature` (base64url). For signed cookies.
- **silentLogger** _(const)_ — `silentLogger: Logger`
  Discards everything — for tests, or when log output is handled elsewhere.
- **sitemap** _(function)_ — `sitemap: (entries: readonly SitemapEntry[], options?: SitemapOptions) => string`
  Build a `<urlset>` sitemap XML document from `entries`. Throws on out-of-spec input (dev-time data).
- **snapshotRoutes** _(function)_ — `snapshotRoutes: (source: unknown) => readonly RouteSnapshot[]`
  Snapshot an app's routes (anything `reflectRoutes` accepts) as plain JSON. Validators are dropped; only introspectable JSON Schema metadata is kept, so the result round-trips through `JSON.stringify` unchanged.
- **sse** _(function)_ — `sse: (c: SSEContext, run: (stream: SSEStream) => void | Promise<void>, init?: SSEInit) => Response`
- **toFetchHandler** _(function)_ — `toFetchHandler: <Env = unknown>(app: { fetch(request: Request, platform?: Platform<Env>): MaybePromise<Response>; resolveWebSocketUpgrade?(request: Request, platform?: Platform<Env>): MaybePromise<WebSocketUpgradeOutcom…`
- **typedSSEStream** _(function)_ — `typedSSEStream: <Event>(stream: SSEStream) => TypedSSEStream<Event>`
  Wrap a raw {@link SSEStream} in the typed, JSON-serializing surface `app.sse()` hands out.
- **unsignValue** _(function)_ — `unsignValue: (signed: string, secret: string) => Promise<string | null>`
  Verify a `value.signature` produced by {@link signValue} and return the value, or `null` if the signature is missing, malformed, or doesn't match. Verification is **constant-time** (`crypto.subtle.verify`), so a wrong signature can't be discovered byte-by-byte via timing.
- **validateStandard** _(function)_ — `validateStandard: <Schema extends StandardSchemaV1>(schema: Schema, value: unknown) => ValidationOutcome<InferOutput<Schema>> | Promise<ValidationOutcome<InferOutput<Schema>>>`
  Run a Standard Schema and normalize the result. Sync validators stay sync; async validators are awaited.
- **verifyWebhook** _(function)_ — `verifyWebhook: (req: Request, secret: string | readonly string[], options?: VerifyWebhookOptions) => Promise<WebhookResult>`
  Verify a webhook request's signature and return its raw payload. Reads `req.body` (bounded), so the body is consumed — parse the returned `payload`, don't re-read the request.
- **withRouteAssurance** _(function)_ — `withRouteAssurance: <T extends object>(target: T, declaration: AssuranceDeclaration | readonly AssuranceDeclaration[]) => T`
  Attach enforcement evidence to the middleware/plugin that installs it.

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

- **DevToolsClientOptions** _(interface)_ — `interface DevToolsClientOptions`
- **DevToolsEvent** _(interface)_ — `interface DevToolsEvent`
- **DevToolsOptions** _(interface)_ — `interface DevToolsOptions`
- **devtools** _(function)_ — `devtools: (options?: DevToolsOptions | undefined) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").AnyServer>`
  DevTools plugin. Its observation adapter projects the single request span into a `DevToolsEvent`; its middleware only owns the secured SSE transport. When configuring `tracing()` yourself, register it before this plugin so DevTools attaches to that request owner.
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

- **CreateMcpServerOptions** _(interface)_ — `interface CreateMcpServerOptions`
- **DefineMcpToolOptions** _(interface)_ — `interface DefineMcpToolOptions`
- **DefineMcpWidgetOptions** _(interface)_ — `interface DefineMcpWidgetOptions`
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
  A render-intent hint for GENERATIVE hosts (e.g. an app-builder host): how to present the result's `structuredContent` when the host renders its OWN themed UI rather than an iframe widget. The host maps the intent to a component in its design system (a shadcn/Tailwind table, form, metric card, …). O…
- **McpWidget** _(interface)_ — `interface McpWidget`
  A widget: the resource to register on the server, its `ui://` URI, and the `_meta` link for its tool.
- **PROTOCOL_VERSION** _(const)_ — `PROTOCOL_VERSION: "2024-11-05"`
  The pure MCP (Model Context Protocol) JSON-RPC dispatch — no I/O, no `Bun.*`, no side effects, so it unit-tests cleanly. A transport (stdio in `@nifrajs/cli`'s `mcp.ts`, Streamable-HTTP in {@link ./http.ts}) wires this to a byte stream; the tools/resources are injected, so the protocol logic is exe…
- **UI_EXTENSION_KEY** _(const)_ — `UI_EXTENSION_KEY: "io.modelcontextprotocol/ui"`
  The `capabilities.extensions` key advertising UI support in the `initialize` result (SEP-1865).
- **UI_MIME** _(const)_ — `UI_MIME: "text/html;profile=mcp-app"`
  The MIME type a UI resource MUST use so a host recognizes it as an MCP App widget (SEP-1865).
- **bridgeScript** _(function)_ — `bridgeScript: () => string`
  The bridge source, as a string for inlining in a `<script>`. Self-contained, no imports.
- **createMcpProtocolState** _(function)_ — `createMcpProtocolState: () => McpProtocolState`
- **createMcpServer** _(function)_ — `createMcpServer: (opts: CreateMcpServerOptions) => McpServer`
- **defineMcpTool** _(function)_ — `defineMcpTool: (opts: DefineMcpToolOptions) => McpTool`
- **defineMcpWidget** _(function)_ — `defineMcpWidget: (opts: DefineMcpWidgetOptions) => McpWidget`
- **handleRpc** _(function)_ — `handleRpc: (message: JsonRpcRequest, tools: readonly McpTool[], serverInfo: { name: string; version: string; }, features?: McpServerFeatures, options?: McpProtocolOptions) => Promise<JsonRpcResponse | null>`
  Dispatch one JSON-RPC message against the given tools. Returns the response, or `null` for a notification (no reply). Tool errors are reported in-band (`isError`) so the agent can react to them.
- **respondMcpHttp** _(function)_ — `respondMcpHttp: (request: Request, tools: McpTool[], serverInfo: { name: string; version: string; }, options?: McpHttpOptions) => Promise<Response>`
  Handle one MCP request over HTTP against the given `tools`/`features`. POST a JSON-RPC body → JSON-RPC response; GET → a plain-text health page; OPTIONS → CORS preflight. Never throws — a bad body becomes a JSON-RPC parse error. The dispatch is the shared, transport-agnostic {@link handleRpc}.
- **rpcError** _(const)_ — `rpcError: (id: JsonRpcId, code: number, message: string) => JsonRpcResponse`
- **rpcResult** _(const)_ — `rpcResult: (id: JsonRpcId, value: unknown) => JsonRpcResponse`
- **uiResourceMeta** _(function)_ — `uiResourceMeta: (uri: string) => Record<string, unknown>`
  The MCP Apps `_meta.ui.resourceUri` link, emitted nested (current spec) AND flat (the deprecated `ui/resourceUri`, still read by some hosts) so a tool renders across the transition.
- **widgetDocument** _(function)_ — `widgetDocument: (opts: DefineMcpWidgetOptions) => string`
  Assemble the full self-contained widget document (bridge inlined in `<head>` so body scripts can use `mcpApp` immediately).

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
- **createCsrfToken** _(function)_ — `createCsrfToken: (secret: string | Uint8Array, nonce?: string) => Promise<string>`
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
  Serve a Web-`fetch` app on a Node `http` server. Resolves once bound — Node binds the port asynchronously, so awaiting gives you the real port (matters for `port: 0`).

## @nifrajs/otel

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
- **ObservationParent** _(interface)_ — `interface ObservationParent`
- **ParsedTraceparent** _(interface)_ — `interface ParsedTraceparent`
  A parsed inbound `traceparent`.
- **SpanExporter** _(type)_ — `type SpanExporter = ObservationAdapter`
  Backwards-compatible name for an observation sink.
- **SpanStatus** _(type)_ — `type SpanStatus = "unset" | "ok" | "error"`
  The span model + exporter seam. Attribute names follow OpenTelemetry HTTP semantic conventions (`http.request.method`, `url.path`, `http.response.status_code`, …) so a span maps cleanly onto an OTel `Span` when bridged — but nothing here depends on the OTel SDK. You supply an {@link ObservationAdap…
- **StartObservation** _(interface)_ — `interface StartObservation`
- **TraceContext** _(type)_ — `type TraceContext = ObservationContext`
  The trace context exposed on the handler `c.trace` (typed, threaded via `derive`).
- **TracingOptions** _(interface)_ — `interface TracingOptions`
- **combineObservationAdapters** _(function)_ — `combineObservationAdapters: (adapters: readonly ObservationAdapter[]) => ObservationAdapter`
  Fan out lifecycle notifications to several adapters. Each adapter is isolated: an exception in one sink cannot prevent the remaining sinks from observing the span.
- **consoleSpanExporter** _(function)_ — `consoleSpanExporter: (log?: (line: string) => void) => SpanExporter`
  A no-frills exporter that logs each completed span as one structured line. Useful in dev or as a starting point before wiring a real backend.
- **createObservationLifecycle** _(function)_ — `createObservationLifecycle: (options?: ObservationLifecycleOptions) => ObservationLifecycle`
  Creates an independent lifecycle factory. Adapters are always called fail-open.
- **formatTraceparent** _(function)_ — `formatTraceparent: (traceId: string, spanId: string, sampled: boolean) => string`
  Format a `traceparent` header value (version `00`).
- **generateSpanId** _(function)_ — `generateSpanId: () => string`
  A fresh 8-byte (16-hex) span id.
- **generateTraceId** _(function)_ — `generateTraceId: () => string`
  A fresh 16-byte (32-hex) trace id.
- **parseTraceparent** _(function)_ — `parseTraceparent: (header: string | null | undefined) => ParsedTraceparent | null`
  Parse a `traceparent` header, or `null` if it's absent/malformed/version-unknown — per the spec, a bad header means "start a fresh trace", never an error. Only version `00` is accepted.
- **traceHeaders** _(function)_ — `traceHeaders: (trace: TraceContext) => { traceparent: string; }`
  Spread into an outgoing `fetch`/`ctx.api` call's headers to continue the trace downstream: `fetch(url, { headers: traceHeaders(c.trace) })`.
- **tracing** _(function)_ — `tracing: (options?: TracingOptions) => import("@nifrajs/core").NifraPlugin<import("@nifrajs/core").AnyServer, import("@nifrajs/core").Server<any, any>>`
  Distributed-tracing plugin. Each request continues the inbound trace (or starts one), opens a server span, and ends it on response with the status + HTTP attributes. Idempotent.

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

- **AdversarialContractError** _(class)_ — `class AdversarialContractError`
- **AdversarialContractOptions** _(interface)_ — `interface AdversarialContractOptions`
- **AdversarialContractReport** _(interface)_ — `interface AdversarialContractReport`
- **AdversarialContractResult** _(interface)_ — `interface AdversarialContractResult`
- **AppLike** _(interface)_ — `interface AppLike`
  The minimal shape a nifra `server()` app satisfies — its own `fetch`.
- **CaptureIncidentOptions** _(interface)_ — `interface CaptureIncidentOptions`
- **CapturedRequest** _(interface)_ — `interface CapturedRequest`
- **CapturedRequestInput** _(interface)_ — `interface CapturedRequestInput`
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
- **GenerateRegressionTestOptions** _(interface)_ — `interface GenerateRegressionTestOptions`
- **IncidentCapsule** _(interface)_ — `interface IncidentCapsule`
- **IncidentReplayError** _(class)_ — `class IncidentReplayError`
- **IncidentReplayResult** _(interface)_ — `interface IncidentReplayResult`
- **ReplayIncidentOptions** _(interface)_ — `interface ReplayIncidentOptions`
- **TestSession** _(interface)_ — `interface TestSession<App>`
- **TestSessionOptions** _(interface)_ — `interface TestSessionOptions`
- **assertAdversarialContract** _(function)_ — `assertAdversarialContract: (app: ContractTestApp, options?: AdversarialContractOptions) => Promise<AdversarialContractReport>`
  Run the contract laboratory and throw an {@link AdversarialContractError} unless it is fully green.
- **assertIncidentReplays** _(function)_ — `assertIncidentReplays: (app: AppLike, capsule: IncidentCapsule, options?: ReplayIncidentOptions) => Promise<void>`
  Assert a captured incident still reproduces against the current app. Throws {@link IncidentReplayError}.
- **captureIncident** _(function)_ — `captureIncident: (request: Request | CapturedRequestInput, response: Response | { status: number; body?: unknown; }, options?: CaptureIncidentOptions) => Promise<IncidentCapsule>`
  Build a capsule from a real `Request`+`Response`, or from plain captured fields.
- **cookieJar** _(function)_ — `cookieJar: () => CookieJar`
  Create an empty cookie jar.
- **generateRegressionTest** _(function)_ — `generateRegressionTest: (capsule: IncidentCapsule, options?: GenerateRegressionTestOptions) => string`
  Emit a committable regression test from a capsule. Request string values are redacted BY DEFAULT with a sanitize banner — replace the `<redacted>` placeholders with safe, reproducing values before you commit. The test asserts the response contract via {@link assertIncidentReplays}.
- **redactForEmission** _(function)_ — `redactForEmission: (value: unknown, allow: ReadonlySet<string>, path?: string) => unknown`
  Redact leaf string values by default (unless the dotted key path is allow-listed). Non-strings are kept — they carry the structure that makes the fixture reproduce — so review the emitted file. This is intentionally aggressive: a committed fixture must not leak PII/secrets.
- **replayIncident** _(function)_ — `replayIncident: (app: AppLike, capsule: IncidentCapsule, options?: ReplayIncidentOptions) => Promise<IncidentReplayResult>`
  Replay a captured incident against the current app and report whether it reproduces.
- **runAdversarialContract** _(function)_ — `runAdversarialContract: (app: ContractTestApp, options?: AdversarialContractOptions) => Promise<AdversarialContractReport>`
  Execute contract-derived hostile inputs and declared-response conformance against a runtime matrix. Runtime/request failures are captured in the report; inspect `report.ok`, `failures`, and `gaps` (or use {@link assertAdversarialContract} for a throwing test assertion).
- **shapeOf** _(function)_ — `shapeOf: (value: unknown) => unknown`
  A stable structural fingerprint: keys + value *types*, not values. Used for the optional shape check.
- **testSession** _(function)_ — `testSession: <App extends AppLike>(app: App, options?: TestSessionOptions) => TestSession<App>`
  Create a cookie-persisting in-process test client for `app`.

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

- **ACTION_GLOBAL** _(const)_ — `ACTION_GLOBAL: "__NIFRA_ACTION__"`
  Global the server serializes an action's data return into (absent on GETs); the client reads it so hydration after a native form POST matches the server-rendered markup.
- **Action** _(type)_ — `type Action = (ctx: LoaderContext) => unknown | Promise<unknown>`
  A route's optional mutation, run on POST. Shares the loader context (params/request/api); read the form/JSON body off `request`. Returns either a `Response` (e.g. a redirect — passed straight through) or data, surfaced to the page component as `actionData`.
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
- **OpenGraphInput** _(interface)_ — `interface OpenGraphInput`
  Inputs for {@link openGraph} — the common Open Graph properties. All optional; only the provided ones become tags. `type` defaults to `"website"`.
- **PRE_HYDRATION_GUARD** _(const)_ — `PRE_HYDRATION_GUARD: string`
  Pre-hydration form guard — a tiny inline script flushed in `<head>` (it runs in the window between first paint and the island bundle taking over). It neutralizes the one real hydration footgun: a JS-only form (a hand-wired `onSubmit` with no native fallback) submitting *natively* before its handler…
- **QueryClient** _(interface)_ — `interface QueryClient`
  The keyed query cache. One per app (a binding registers it like the router).
- **QueryClientOptions** _(interface)_ — `interface QueryClientOptions`
- **QueryHandle** _(interface)_ — `interface QueryHandle<T = unknown>`
  A stable per-key handle: subscribe to its state, read a snapshot, trigger a fetch/refetch.
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
- **createQueryClient** _(function)_ — `createQueryClient: (options: QueryClientOptions) => QueryClient`
- **createWebApp** _(function)_ — `createWebApp: <Env = unknown>(options: CreateWebAppOptions) => ReturnType<typeof server<Env>>`
  Build a nifra app from a route manifest: every route SSRs its layout chain via `renderPage`, and a wildcard catch-all renders `_404` (or a plain 404). Reuses
- **defer** _(function)_ — `defer: <T>(promise: Promise<T>) => Deferred<T>`
  Mark a loader value as deferred — it streams in after the shell instead of blocking it. Works **anywhere** in the loader's returned data — a top-level key, or nested in objects/arrays:
- **disableDraft** _(function)_ — `disableDraft: (c: { readonly set: DraftCookieControls; }, options?: { readonly path?: string; }) => void`
  Turn draft mode **off**: clear the `__nifra_draft` cookie. Match the `path` used in `enableDraft`.
- **enableDraft** _(function)_ — `enableDraft: (c: { readonly set: DraftCookieControls; }, secret: string, options?: EnableDraftOptions) => Promise<void>`
  Turn draft mode **on** for this client by setting a signed, HttpOnly `__nifra_draft` cookie. Call it from a route you've already authorized. `secret` signs the cookie — pass the SAME secret to `createWebApp({ draftSecret })` and `withISR({ draftSecret })` so the framework can verify it.
- **enumeratePrerenderedPaths** _(function)_ — `enumeratePrerenderedPaths: (routes: readonly RouteEntry[]) => Promise<string[]>`
  The prerendered-path subset of {@link enumerateStaticRoutes} — kept for callers that only need the paths (e.g. injecting `window.__NIFRA_PRERENDERED__`).
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
- **redirect** _(function)_ — `redirect: (location: string, statusOrOptions?: number | RedirectOptions) => Response`
  Build a redirect `Response` — return it from a route `action` for the Post/Redirect/Get pattern (POST mutates, 303 sends the browser to a fresh GET, so a reload doesn't re-submit). Defaults to 303 (See Other); pass `307`/`308` (or `{ status }`) to preserve the method.
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
- **withISR** _(function)_ — `withISR: (app: ISRApp, options: ISROptions) => (req: Request, platform?: ISRPlatform) => Promise<Response>`
  Wrap a nifra app with **Incremental Static Regeneration**: a cacheable page is served from {@link CacheStore} when fresh, served **stale while a fresh copy regenerates in the background** (`platform.waitUntil` on edge), or rendered + stored on a miss. Framework-agnostic (it caches the rendered byte…

## @nifrajs/web-preact

- **preactAdapter** _(const)_ — `preactAdapter: RenderAdapter`
  The Preact server render adapter — pass to

## @nifrajs/web-react

- **reactAdapter** _(const)_ — `reactAdapter: RenderAdapter`
  The React server render adapter — pass to

## @nifrajs/web-solid

- **solidAdapter** _(const)_ — `solidAdapter: RenderAdapter`
  The Solid server render adapter — pass to
- **solidBunPlugin** _(function)_ — `solidBunPlugin: (generate: "dom" | "ssr") => BunPlugin`
  Bun build/runtime plugin that compiles Solid components with Babel — `generate: "ssr"` for the server, `"dom"` for the client, `hydratable` so SSR and hydrate align. Solid's reactive-JSX compiler ships only as a Babel plugin (no swc/native port); this runs at build time, on `.tsx` files only.

## @nifrajs/web-svelte

- **svelteAdapter** _(const)_ — `svelteAdapter: RenderAdapter`
  The Svelte server render adapter — pass to
- **svelteBunPlugin** _(function)_ — `svelteBunPlugin: (generate: "dom" | "ssr") => BunPlugin`

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

- **vueAdapter** _(const)_ — `vueAdapter: RenderAdapter`
  The Vue server render adapter — pass to

## @nifrajs/workers

- **WebSocketHubApp** _(interface)_ — `interface WebSocketHubApp<Env = unknown>`
  The nifra-app surface the hub needs — every `server()` app satisfies it.
- **WebSocketHubClass** _(type)_ — `type WebSocketHubClass<Env> = new ( state: DurableObjectStateLike, env: Env, ) => { fetch(request: Request): Promise<Response> }`
  The Durable Object class shape `createWebSocketHub` returns.
- **createWebSocketHub** _(function)_ — `createWebSocketHub: <Env = unknown>(app: WebSocketHubApp<Env>) => WebSocketHubClass<Env>`
  Build a Durable Object class that serves an app's `app.ws()` routes with **cross-connection broadcast**. Every WebSocket accepted here lives in the DO's isolate, and the app's `TopicRegistry` lives there too — so `ws.subscribe(topic)` and `app.publish(topic, data)` (called from the WS lifecycle) re…

## nifra

- **AnyServer** _(type)_ — `type AnyServer = Server<any, any>`
- **AssuranceConfig** _(interface)_ — `interface AssuranceConfig`
- **AssuranceDeclaration** _(interface)_ — `interface AssuranceDeclaration`
  Metadata installed on a middleware/plugin by {@link withRouteAssurance}.
- **AssuranceEvidence** _(interface)_ — `interface AssuranceEvidence`
  Reflection-safe proof that a named enforcement module covered a route.
- **AssuranceFinding** _(interface)_ — `interface AssuranceFinding`
- **AssuranceFindingCode** _(type)_ — `type AssuranceFindingCode = | "no-routes" | "unclassified-route" | "missing-evidence" | "forbidden-evidence"`
- **AssurancePolicy** _(interface)_ — `interface AssurancePolicy`
- **AssuranceReport** _(interface)_ — `interface AssuranceReport`
- **AssuranceRouteSelector** _(interface)_ — `interface AssuranceRouteSelector`
- **AssuranceRule** _(interface)_ — `interface AssuranceRule`
- **AssuranceScope** _(type)_ — `type AssuranceScope = "global" | "subsequent" | "plugin"`
  Where enforcement evidence follows Nifra's route-registration semantics.
- **AssuredRoute** _(interface)_ — `interface AssuredRoute`
- **Context** _(interface)_ — `interface Context<Path extends string = string, S extends RouteSchema = RouteSchema>`
  Handler context. `params` are inferred from the path; `body` and `query` are the validated outputs of their schemas when declared (else `undefined` / raw `URLSearchParams`).
- **ContextForOp** _(type)_ — `type ContextForOp<O extends OperationDef> = Context<O["path"], SchemaForOp<O> & RouteSchema>`
  The handler context for an op — identical to the inline `Context<Path, S>`, so a handler written for an inline route type-checks unchanged under `implement` (the graduation guarantee).
- **ContractShape** _(type)_ — `type ContractShape = Record<string, OperationDef>`
  A contract: named operations. Names are the handler keys and OpenAPI operationIds.
- **CookieOptions** _(interface)_ — `interface CookieOptions`
  Attributes for a `Set-Cookie`. `expires` is a `Date`; `maxAge` is in **seconds**.
- **DiffSeverity** _(type)_ — `type DiffSeverity = "breaking" | "compatible" | "info"`
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
- **HandlersFor** _(type)_ — `type HandlersFor<C extends ContractShape> = { [K in keyof C]: (context: ContextForOp<C[K]>) => MaybePromise<HandlerReturnForOp<C[K]>> }`
  The handlers `implement` requires: one per operation, typed from the op's input + response contract.
- **IdentityPlugin** _(type)_ — `type IdentityPlugin = (<S extends AnyServer>(app: S) => S) & { readonly pluginName?: string }`
  A named type-identity plugin built with {@link defineIdentityPlugin}. It returns the same concrete server type it receives, preserving the caller's typed registry and context across `.use()` while still allowing the plugin to register runtime hooks or handlers.
- **InferInput** _(type)_ — `type InferInput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["input"]`
- **InferOutput** _(type)_ — `type InferOutput<Schema extends StandardSchemaV1> = NonNullable< Schema["~standard"]["types"] >["output"]`
- **JsonSchema** _(type)_ — `type JsonSchema = boolean | Readonly<Record<string, unknown>>`
  JSON Schema permits either a schema object or the boolean schemas `true` and `false`.
- **LogFields** _(type)_ — `type LogFields = Record<string, unknown>`
  Structured, redacting logger. The framework logs through this interface so secrets/PII are scrubbed once, centrally (per the project's logging rule), not at each call site. Bring your own by passing `logger` to `server()`.
- **Logger** _(interface)_ — `interface Logger`
- **METHODS** _(const)_ — `METHODS: readonly ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]`
  HTTP methods the router accepts.
- **McpPromptDescriptor** _(interface)_ — `interface McpPromptDescriptor`
  An app-declared MCP prompt — a reusable prompt template an agent can fetch through `nifra mcp`.
- **McpResourceDescriptor** _(interface)_ — `interface McpResourceDescriptor`
  An app-declared MCP resource — read-only data an agent can fetch through `nifra mcp`.
- **Method** _(type)_ — `type Method = (typeof METHODS)[number]`
- **Middleware** _(interface)_ — `interface Middleware`
  A bundle of lifecycle hooks applied together via {@link Server.use} — the unit `@nifrajs/middleware` ships (cors, security headers, rate-limit). Every hook is optional and wired to its lifecycle point. Middleware is context-agnostic (sees the base `Context`); `use` does no context-type merging — th…
- **NIFRA_ASSURANCE** _(const)_ — `NIFRA_ASSURANCE: Readonly<{ readonly AUTHENTICATED: "nifra.authenticated"; readonly BODY_BOUNDED: "nifra.body-bounded"; readonly CSRF: "nifra.csrf"; readonly IDEMPOTENCY_KEY: "nifra.idempotency-key"; readonly IP_RESTRIC…`
  Canonical evidence ids emitted by Nifra's official middleware modules.
- **NifraPlugin** _(type)_ — `type NifraPlugin<In extends AnyServer = AnyServer, Out extends AnyServer = In> = (( app: In, ) => Out) & { readonly pluginName?: string }`
  A nifra **plugin**: a function that augments an app — calling `use`/`derive`/`decorate` and/or registering routes — and returns it. Because `derive`/`decorate` are type-threaded, an **inline** `app.use((a) => a.derive(...).decorate(...))` carries the added context to handlers defined after it (the …
- **NifraWebSocket** _(interface)_ — `interface NifraWebSocket<Data = unknown>`
  The portable socket handed to WS lifecycle callbacks. Each adapter wraps its native socket.
- **NodeServeOutcome** _(type)_ — `type NodeServeOutcome`
  What {@link Server.resolveNode} returns: either a plain-data render the `@nifrajs/node` adapter writes to the socket directly (`kind: "json"` — status + headers + cookies + a pre-stringified body, **no** undici `Response` built or drained), a marked buffered response body (`kind: "body"` — e.g.
- **OnRequestResult** _(type)_ — `type OnRequestResult = Response | Request | undefined`
- **OperationDef** _(interface)_ — `interface OperationDef`
  One operation in a contract. Input schemas are any Standard Schema; `response` is optional.
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
- **ReflectedRoute** _(interface)_ — `interface ReflectedRoute`
- **ReflectedRouteSchema** _(interface)_ — `interface ReflectedRouteSchema`
- **ReflectedSchemaField** _(interface)_ — `interface ReflectedSchemaField`
  One top-level property of an introspectable object schema.
- **Registry** _(type)_ — `type Registry = Record<string, Record<string, RouteInfo>>`
  The accumulated, type-level map of every route on a Server: path → method → RouteInfo.
- **RegistryFor** _(type)_ — `type RegistryFor<C extends ContractShape> = { [P in C[keyof C]["path"]]: { [K in keyof C as C[K]["path"] extends P ? C[K]["method"] : never]: RouteInfoForOp<C[K]> } }`
  Re-key the name-keyed ops into the `path → method → RouteInfo` registry.
- **RegistryFromImpl** _(type)_ — `type RegistryFromImpl<C extends ContractShape, H extends HandlersFor<C>>`
  The registry produced by `implement`: input from the contract op; `output` is the declared `response` contract when present (it wins — exactly as in the inline path), else the bound HANDLER's return — so the implemented server stays route-for-route identical to the equivalent inline server (the mod…
- **ResponseControls** _(interface)_ — `interface ResponseControls`
  Mutable response controls a handler may write to before returning.
- **ResponseDef** _(interface)_ — `interface ResponseDef`
  An additional (non-success) response a contract operation can document, e.g. a `404`.
- **ResponseFinalization** _(interface)_ — `interface ResponseFinalization`
  The terminal response-pipeline outcome observed after every transforming `onResponse` hook.
- **RobotsOptions** _(interface)_ — `interface RobotsOptions`
- **RobotsRule** _(interface)_ — `interface RobotsRule`
- **RouteChange** _(interface)_ — `interface RouteChange`
- **RouteConfigError** _(class)_ — `class RouteConfigError`
  Thrown at route registration when a route is misconfigured. This is the boot-time rejection layer: loud and early, never deferred to the first request.
- **RouteConfigErrorCode** _(type)_ — `type RouteConfigErrorCode = | "DUPLICATE_ROUTE" | "DUPLICATE_PARAM" | "PARAM_NAME_CONFLICT" | "INVALID_PATH" | "INVALID_PARAM_NAME" | "WILDCARD_NOT_LAST" | "INVALID_METHOD"`
  Stable codes for boot-time (L2) route configuration failures.
- **RouteDescriptor** _(interface)_ — `interface RouteDescriptor`
  A registered route's public descriptor — method, path, and input schemas. The router trie discards the original patterns, so this flat list is what lets tools (e.g. `toOpenAPI`) enumerate routes after registration.
- **RouteInfo** _(interface)_ — `interface RouteInfo`
  One route's input/output shape as the **client** will consume it. `query`/`body` are `never` when the route declares no schema for them, so the client can detect "this route takes no body" via `[body] extends [never]`. `output` is the handler's raw return type (the client applies `Jsonify` when rea…
- **RouteSchema** _(interface)_ — `interface RouteSchema`
  Per-route input schemas. Each is any Standard Schema (zod/valibot/arktype/…).
- **RouteSnapshot** _(interface)_ — `interface RouteSnapshot`
  One route in a snapshot — plain JSON, safe to persist as a CI baseline.
- **RouteSnapshotSchema** _(interface)_ — `interface RouteSnapshotSchema`
- **Router** _(class)_ — `class Router<T>`
  Radix-style segment trie router. Matching precedence is static > param > wildcard. Parameter/wildcard values are returned RAW (not percent-decoded); the server boundary decodes and rejects malformed encodings with a 400, keeping this layer pure and allocation-light.
- **RouterMatch** _(type)_ — `type RouterMatch<T>`
  Result of {@link Router.find}. The `found: false` cases deliberately separate a missing path (404) from a path that exists for other methods (405), so the server layer can answer correctly and populate an `Allow` header.
- **RoutesDiff** _(interface)_ — `interface RoutesDiff`
- **RunningServer** _(interface)_ — `interface RunningServer`
  The handle `listen()` returns — the slice of Bun's server nifra holds and exposes. Declared explicitly (rather than `ReturnType<typeof Bun.serve>`) so the public type surface doesn't leak the ambient `Bun` global into consumers' `.d.ts` resolution.
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
- **SchemaReflection** _(interface)_ — `interface SchemaReflection`
  Validation and introspection capabilities discovered for one schema-like value.
- **SchemaSnapshot** _(interface)_ — `interface SchemaSnapshot`
  One schema position in a snapshot: JSON Schema metadata only, no validator.
- **Server** _(class)_ — `class Server<R extends Registry = EmptyRegistry, Ctx = EmptyContext>`
  The inline server. Routes are chainable and fully type-inferred. `derive`/ `decorate` extend the handler context (`Ctx`) for routes defined *after* them, with full types; `Ctx` is server-only and never touches the client registry.
- **ServerOptions** _(interface)_ — `interface ServerOptions`
- **SignatureEncoding** _(type)_ — `type SignatureEncoding = "hex" | "base64"`
- **SitemapChangeFreq** _(type)_ — `type SitemapChangeFreq = | "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never"`
- **SitemapEntry** _(interface)_ — `interface SitemapEntry`
- **SitemapOptions** _(interface)_ — `interface SitemapOptions`
- **StandardIssue** _(interface)_ — `interface StandardIssue`
- **StandardResult** _(type)_ — `type StandardResult<Output> = StandardSuccess<Output> | StandardFailure`
- **StandardSchemaV1** _(interface)_ — `interface StandardSchemaV1<Input = unknown, Output = Input>`
  The Standard Schema v1 interface (https://standardschema.dev), vendored as types + a tiny runtime helper so any compliant validator — zod, valibot, arktype, … — validates requests without coupling the framework to one lib. The spec is MIT-licensed and explicitly designed to be copied.
- **StandardTypes** _(interface)_ — `interface StandardTypes<Input = unknown, Output = Input>`
- **StandardWebSocket** _(interface)_ — `interface StandardWebSocket`
  A standard server-side `WebSocket` — the half returned by Deno's `Deno.upgradeWebSocket` and the Workers `WebSocketPair`. {@link attachWebSocket} wires one to a nifra handler, so the Deno and Workers bridges share all the dispatch/normalization/error-isolation logic (only the upgrade call differs).
- **ToolAnnotations** _(interface)_ — `interface ToolAnnotations`
  MCP tool safety hints, surfaced in `tools/list`, that tell an agent how risky a `.tool()` call is — so it can decide whether to auto-invoke or confirm first. All optional; an omitted hint means "unknown". Mirrors the MCP spec's tool `annotations`.
- **TopicRegistry** _(class)_ — `class TopicRegistry`
  In-process pub/sub for `ws.subscribe(topic)` + `app.publish(topic, data)`. **Single-instance only** — topics live in this process's memory, so a multi-instance deploy (multiple servers behind a load balancer) needs an external fan-out (Redis pub/sub, a Cloudflare Durable Object, NATS, …) bridged to…
- **TypedSSEStream** _(interface)_ — `interface TypedSSEStream<Event>`
  The stream handed to an `app.sse()` handler: `send` takes the route's TYPED event payload and serializes it (JSON) into the SSE `data:` field — the compile-time half of the `sse` contract.
- **VERSION** _(const)_ — `VERSION: "1.8.0"`
  Current package version. A hardcoded literal on purpose — core runs on the edge (no fs), so it can't read its own package.json at runtime. `scripts/version.ts` rewrites it on every release bump and `check:publish` asserts it equals `@nifrajs/core`'s package version, so the literal can't go stale (i…
- **ValidationOutcome** _(type)_ — `type ValidationOutcome<Output> = | { readonly ok: true; readonly value: Output } | { readonly ok: false; readonly issues: ReadonlyArray<StandardIssue> }`
- **VerifyWebhookOptions** _(interface)_ — `interface VerifyWebhookOptions`
- **Version** _(type)_ — `type Version = typeof VERSION`
- **WebSocketContext** _(interface)_ — `interface WebSocketContext<Env = unknown>`
  The request-context subset the `upgrade()` guard sees — the same lazy accessors a route handler's `c` has (cookies/headers/env are read straight off the upgrade request). Structurally a slice of the core `RawContext`, so the real context object satisfies it.
- **WebSocketData** _(type)_ — `type WebSocketData = string | Uint8Array`
  A received frame, normalized across runtimes: text → `string`, binary → `Uint8Array`.
- **WebSocketHandler** _(interface)_ — `interface WebSocketHandler<Data = unknown, Env = unknown, Schema extends StandardSchemaV1 | undefined = undefined>`
  A WebSocket route's lifecycle. All callbacks optional; only `message` is needed for an echo.
- **WebSocketUpgradeOutcome** _(type)_ — `type WebSocketUpgradeOutcome`
  The outcome of `app.resolveWebSocketUpgrade(req)` — for serving adapters: - `pass` — not a WS upgrade for a registered WS route; handle as a normal HTTP request. - `reject` — a WS route matched but `upgrade()` rejected (or the path was malformed); return `response`. - `upgrade` — perform the runtim…
- **WebhookFailureReason** _(type)_ — `type WebhookFailureReason = | "missing_signature" | "invalid_signature" | "timestamp_out_of_tolerance" | "malformed_signature" | "payload_too_large" | "invalid_content_length"`
- **WebhookProvider** _(type)_ — `type WebhookProvider = "stripe" | "github" | "generic"`
- **WebhookResult** _(type)_ — `type WebhookResult = | { readonly ok: true; readonly payload: string } | { readonly ok: false; readonly reason: WebhookFailureReason }`
  Verified ⇒ the raw `payload` text (parse it with your schema). Rejected ⇒ a stable `reason`.
- **attachWebSocket** _(function)_ — `attachWebSocket: (socket: StandardWebSocket, handler: WebSocketHandler, data: unknown, options: { openNow: boolean; pubsub: TopicRegistry; }) => NifraWebSocket`
  Wire a standard server-side `WebSocket` to a nifra {@link WebSocketHandler}, returning the portable {@link NifraWebSocket}. Shared by the Deno and Workers bridges. `openNow` fires `open` immediately (Workers, where the socket is already open after `accept()`); otherwise `open` waits for the socket'…
- **commonSecretPatterns** _(const)_ — `commonSecretPatterns: readonly RegExp[]`
  A conservative, high-signal set of patterns for {@link RedactOptions.valuePatterns} — opt in by passing it (or a subset) to `jsonLogger`/`redactLogFields`. Covers bearer tokens, JWTs, emails, and a few well-known key formats (Stripe, GitHub, AWS access-key ids). Chosen to minimize false positives; …
- **defineAssuranceConfig** _(function)_ — `defineAssuranceConfig: (config: AssuranceConfig) => AssuranceConfig`
  Identity helper for a `nifra.assurance.ts` default export.
- **defineAssurancePolicy** _(function)_ — `defineAssurancePolicy: (policy: AssurancePolicy) => AssurancePolicy`
  Validate and freeze an ordered assurance policy.
- **defineContract** _(function)_ — `defineContract: <const C extends ContractShape>(contract: C) => C`
  Define a standalone, versionable contract. Identity at runtime (it returns the contract for type inference via the `const` type parameter, which preserves the path/method literals) plus boot-time (L2) validation: each operation must use a known method, a path starting with `/`, and no two operation…
- **defineIdentityPlugin** _(function)_ — `defineIdentityPlugin: (name: string, apply: <S extends AnyServer>(app: S) => S) => IdentityPlugin`
  Define a type-**identity** plugin: it registers routes/hooks as a side effect but returns the app with its `Registry` + `Context` UNCHANGED. Use this (not {@link definePlugin}) for any plugin that doesn't add context types — e.g. one mounting an auth handler. It threads the caller's *concrete* serv…
- **definePlugin** _(function)_ — `definePlugin: <In extends AnyServer, Out extends AnyServer>(name: string, apply: (app: In) => Out) => NifraPlugin<In, Out>`
  Name + ergonomics for a plugin that **adds typed context** (`derive`/`decorate`). `app.use(myPlugin)` applies it once; a second `use` of the same name is skipped (idempotent), so plugins can depend on each other without double-registering hooks.
- **defineRouterPlugin** _(const)_ — `defineRouterPlugin: (name: string, apply: <S extends AnyServer>(app: S) => S) => IdentityPlugin`
  Alias of {@link defineIdentityPlugin} with a name that says what it's FOR: a plugin that **mounts routes/hooks but adds no context type** (an auth router, an audit logger). Use this — not {@link definePlugin} — for any such plugin, or the typed client silently collapses to `any`. The "identity" in …
- **diffRouteSnapshots** _(function)_ — `diffRouteSnapshots: (before: readonly RouteSnapshot[], after: readonly RouteSnapshot[]) => RoutesDiff`
  Diff two route snapshots (`snapshotRoutes` output, possibly restored from JSON). Every change is classified breaking/compatible/info; `hasBreaking` is the CI-gate bit.
- **evaluateRouteAssurance** _(function)_ — `evaluateRouteAssurance: (source: unknown, policyInput: AssurancePolicy) => AssuranceReport`
  Evaluate reflected route evidence against the first matching policy rule.
- **implement** _(function)_ — `implement: <const C extends ContractShape, H extends HandlersFor<C>>(contract: C, handlers: H) => Server<RegistryFromImpl<C, H>>`
  Bind handlers to a contract, producing a real {@link Server} you can `.listen()` or `.fetch()`. Each op is registered through the same path as the inline builder, so the result is identical to writing the routes inline — handlers lift over **unchanged** ("graduation"), and body/query schemas valida…
- **jsonLogger** _(function)_ — `jsonLogger: (write?: (line: string) => void, options?: RedactOptions) => Logger`
  The default logger: one redacted JSON object per line. `write` is injectable for tests or alternative sinks (defaults to stderr). `options` tunes redaction — pass `valuePatterns` (e.g. {@link commonSecretPatterns}) to also scrub secrets embedded in values + the message. Framework keys (`level`, `me…
- **matchesAssuranceSelector** _(function)_ — `matchesAssuranceSelector: (route: Pick<ReflectedRoute, "method" | "path" | "tool">, selector: AssuranceRouteSelector) => boolean`
  Shared selector semantics for policy rules and framework adapters.
- **parseCookies** _(function)_ — `parseCookies: (header: string | null | undefined) => Record<string, string>`
  Parse a request `Cookie` header into a name→value map (values URL-decoded). Unparseable pairs are skipped rather than throwing — a junk `Cookie` header shouldn't fail the request.
- **redactLogFields** _(function)_ — `redactLogFields: (fields: LogFields, options?: RedactOptions) => LogFields`
  Deep-copy `fields`, replacing values under sensitive keys with the placeholder; cycle-safe. With `options.valuePatterns`, also scans string values for those patterns (opt-in). Without options, this is pure key-name redaction (the long-standing default).
- **reflectRoutes** _(function)_ — `reflectRoutes: (source: unknown) => readonly ReflectedRoute[]`
  Safely enumerate and normalize route descriptors from an app or descriptor array. Invalid entries are ignored; a missing/throwing `routes()` method yields an empty array.
- **reflectSchema** _(function)_ — `reflectSchema: (value: unknown) => SchemaReflection`
  Reflect a Standard Schema, Nifra/TypeBox schema carrier, or raw JSON Schema. Never throws. Validation-only schemas have `standard` but no `jsonSchema`; raw JSON Schema has the reverse.
- **robots** _(function)_ — `robots: (options: RobotsOptions) => string`
  Build a `robots.txt` body from grouped rules plus optional `Sitemap:`/`Host:` lines.
- **serializeCookie** _(function)_ — `serializeCookie: (name: string, value: string, options?: CookieOptions) => string`
  Serialize a `Set-Cookie` header value. Pure — applies **no** security defaults (the caller, e.g. `c.set.cookie`, layers `HttpOnly`/`Secure`/`SameSite` on). Throws on an invalid cookie name, a header-injecting `Path`/`Domain`, a non-integer `maxAge`, or an oversized result — a serialization bug shou…
- **server** _(function)_ — `server: <Env = unknown>(options?: ServerOptions) => Server<EmptyRegistry, { readonly env: Env; }>`
  Create a new {@link Server}. Pass an `Env` to type the platform bindings — `server<Env>()` makes `c.env: Env` in every handler + middleware, and types the `env` argument of `app.fetch` / `toFetchHandler`. Omit it and `c.env` is `unknown` (validate/cast before use).
- **signValue** _(function)_ — `signValue: (value: string, secret: string) => Promise<string>`
  Append an HMAC-SHA256 signature to a value → `value.signature` (base64url). For signed cookies.
- **silentLogger** _(const)_ — `silentLogger: Logger`
  Discards everything — for tests, or when log output is handled elsewhere.
- **sitemap** _(function)_ — `sitemap: (entries: readonly SitemapEntry[], options?: SitemapOptions) => string`
  Build a `<urlset>` sitemap XML document from `entries`. Throws on out-of-spec input (dev-time data).
- **snapshotRoutes** _(function)_ — `snapshotRoutes: (source: unknown) => readonly RouteSnapshot[]`
  Snapshot an app's routes (anything `reflectRoutes` accepts) as plain JSON. Validators are dropped; only introspectable JSON Schema metadata is kept, so the result round-trips through `JSON.stringify` unchanged.
- **sse** _(function)_ — `sse: (c: SSEContext, run: (stream: SSEStream) => void | Promise<void>, init?: SSEInit) => Response`
- **toFetchHandler** _(function)_ — `toFetchHandler: <Env = unknown>(app: { fetch(request: Request, platform?: Platform<Env>): MaybePromise<Response>; resolveWebSocketUpgrade?(request: Request, platform?: Platform<Env>): MaybePromise<WebSocketUpgradeOutcom…`
- **typedSSEStream** _(function)_ — `typedSSEStream: <Event>(stream: SSEStream) => TypedSSEStream<Event>`
  Wrap a raw {@link SSEStream} in the typed, JSON-serializing surface `app.sse()` hands out.
- **unsignValue** _(function)_ — `unsignValue: (signed: string, secret: string) => Promise<string | null>`
  Verify a `value.signature` produced by {@link signValue} and return the value, or `null` if the signature is missing, malformed, or doesn't match. Verification is **constant-time** (`crypto.subtle.verify`), so a wrong signature can't be discovered byte-by-byte via timing.
- **validateStandard** _(function)_ — `validateStandard: <Schema extends StandardSchemaV1>(schema: Schema, value: unknown) => ValidationOutcome<InferOutput<Schema>> | Promise<ValidationOutcome<InferOutput<Schema>>>`
  Run a Standard Schema and normalize the result. Sync validators stay sync; async validators are awaited.
- **verifyWebhook** _(function)_ — `verifyWebhook: (req: Request, secret: string | readonly string[], options?: VerifyWebhookOptions) => Promise<WebhookResult>`
  Verify a webhook request's signature and return its raw payload. Reads `req.body` (bounded), so the body is consumed — parse the returned `payload`, don't re-read the request.
- **withRouteAssurance** _(function)_ — `withRouteAssurance: <T extends object>(target: T, declaration: AssuranceDeclaration | readonly AssuranceDeclaration[]) => T`
  Attach enforcement evidence to the middleware/plugin that installs it.
