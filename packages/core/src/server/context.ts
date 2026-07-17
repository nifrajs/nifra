import type { RequestBudget } from "../budget.ts"
import type { DataClassification } from "../classification.ts"
import type { IdempotencyScope, IdempotencyStore } from "../idempotency.ts"
import type { InferOutput, StandardIssue, StandardSchemaV1 } from "../schema/standard.ts"
import type { CookieOptions } from "./cookies.ts"

/**
 * Declares a mutating route as idempotent: the server dedupes retries on an `Idempotency-Key` header
 * (see {@link RouteSchema.idempotency}). Satisfies the capability-assurance idempotency requirement
 * for a request-idempotent `write` capability. Durable response replay is deliberately NOT durable-
 * command evidence: a command/provider key must still prove the side effect itself is deduplicated.
 */
export interface IdempotencyConfig {
  /** `request` = in-process dedupe; `durable` = cross-restart, backed by a durable store. */
  readonly scope: IdempotencyScope
  /** Retention for the stored response. Default 24h. */
  readonly ttlMs?: number
  /** Store override. Defaults to the server's shared in-memory store; inject a durable store here. */
  readonly store?: IdempotencyStore
  /** Header carrying the key. Default `idempotency-key`. */
  readonly headerName?: string
  /** Maximum response bytes retained for replay. Defaults to the server body limit. */
  readonly maxResponseBytes?: number
  /**
   * Required server-owned key namespace. Use a tenant/subject-scoped opaque token for authenticated
   * routes so two principals choosing the same header key never collide. A static namespace is an
   * explicit shared/public scope and is safe only when the response is principal-independent. The
   * resolver receives a clone and must not derive identity from unauthenticated client input.
   */
  readonly namespace:
    | string
    | ((
        request: {
          readonly method: string
          readonly url: string
          readonly headers: { get(name: string): string | null }
        },
        platform: Platform | undefined,
      ) => string | Promise<string>)
}

/** Flattens an intersection into a single object type for readable hovers. */
export type Prettify<T> = { [K in keyof T]: T[K] } & {}

/**
 * Extracts `:param` and trailing `*wildcard` names from a route-path literal into
 * a string→string record: `/users/:id/posts/:postId` → `{ id: string; postId:
 * string }`, `/files/*path` → `{ path: string }`, `/files/*` → `{ "*": string }`.
 * A non-literal `string` path widens to `Record<string, string>`.
 */
type RawParams<Path extends string> = string extends Path
  ? Record<string, string>
  : Path extends `${infer _Start}:${infer Param}/${infer Rest}`
    ? Record<Param, string> & RawParams<`/${Rest}`>
    : Path extends `${infer _Start}:${infer Param}`
      ? Record<Param, string>
      : Path extends `${infer _Start}*${infer Wild}`
        ? Record<Wild extends "" ? "*" : Wild, string>
        : Record<never, string>

export type Params<Path extends string> = Prettify<RawParams<Path>>

/** Per-route input schemas. Each is any Standard Schema (zod/valibot/arktype/…). */
export interface RouteSchema {
  /** Declared effect tokens. Reflected for assurance; never read by validation or serialization. */
  readonly capabilities?: readonly string[]
  /**
   * Dedupe retries of this (mutating) route on an `Idempotency-Key` header. The first request runs and
   * its response is stored; a retry with the same key replays that response without re-running the
   * handler, and a key reused with a different body is rejected (409). A missing key on an
   * idempotency-required route fails closed (400). Off the hot path — routes without it are unchanged.
   */
  readonly idempotency?: IdempotencyConfig
  /**
   * Highest data-sensitivity this route's response body carries (`public` | `pii` | `secret`). A
   * declarative, compile-time + introspection fact — never validated at runtime. Reflected for tooling,
   * recorded in the capability lockfile (so a route that starts returning PII is a reviewable change),
   * and read by downstream policy (e.g. a partner-API surface refusing to expose `pii`/`secret`).
   */
  readonly classification?: DataClassification
  /**
   * Inline **route-assurance evidence**: the enforcement posture this route carries, declared adjacent to
   * the handler (e.g. `[NIFRA_ASSURANCE.AUTHENTICATED]`). Each id becomes route-scoped `declared` evidence
   * in reflection, so a `nifra.assurance.ts` policy `require:` clause is satisfiable WITHOUT rewriting an
   * in-handler guard into a `withRouteAssurance`-marked middleware. Ids are lowercase dot/dash segments
   * (invalid ids throw at registration). Reflected for the assurance gate; never read on the hot path.
   *
   * This is an author ASSERTION (recorded as `source: "declared"`), not runtime proof - like every
   * assurance marker it is trusted by the static gate, which matches on the evidence id, not its source.
   * Declare an id only on a route whose guard actually enforces it; a false declaration silently satisfies
   * the policy. (`source` is retained in reflection, so a stricter policy or reviewer can still tell
   * declared evidence from enforcement-module evidence.)
   */
  readonly assurance?: readonly string[]
  /**
   * Mark this route a **dynamic route family**: a template (`/api/:slug/:resource`) whose concrete
   * resources are resolved at runtime (auto-CRUD over tenant-defined tables, a catch-all dispatcher).
   * Purely declarative - it does not change dispatch. It surfaces in reflection so the assurance gate and
   * tooling treat the one templated route as a deliberate family whose evidence covers every runtime-
   * resolved resource, instead of reading it as a single forgotten route.
   */
  readonly family?: boolean
  /** Optional **path-params schema**. Path params arrive as strings (`/users/:id` -> `c.params.id`);
   * declaring a schema validates them at the boundary (a malformed `:id` is a `422` before the handler,
   * like `body`/`query`) and can coerce them (use `t.query({ id: t.integer() })` for a numeric param).
   * The schema must cover every path param; with the strict default an undeclared path param is rejected.
   * When omitted, `c.params` stays the path-inferred `Record<name, string>`. */
  readonly params?: StandardSchemaV1
  readonly body?: StandardSchemaV1
  readonly query?: StandardSchemaV1
  /** Optional **response contract**. When declared: the handler's return is type-checked against it
   * (the implementation can't drift from the contract), the typed client sees THIS as the response type
   * (the contract — not the handler's incidental return), and it's emitted into OpenAPI/JSON-Schema so
   * tooling and coding agents can read the exact shape. It is **not** validated at runtime (zero
   * hot-path cost) — purely a compile-time + introspection contract. */
  readonly response?: StandardSchemaV1
  /**
   * Optional **error-response contract**: a map of HTTP status code → the Standard Schema of that error's
   * body. Declares a route's failure modes so they flow into OpenAPI (as non-2xx `responses`), the
   * `/llms.txt` context, and other introspection — the whole contract, not just the happy path, is legible
   * to tooling and coding agents. Like `response`, it is **not** validated at runtime (zero hot-path cost);
   * it's a compile-time + introspection contract. Example: `{ 404: NotFound, 409: Conflict }`. */
  readonly errors?: Readonly<Record<number, StandardSchemaV1>>
  /**
   * Optional **SSE event contract**: the Standard Schema of each event's `data` payload on a
   * streaming route (declared via `app.sse()`). Marks the route as a typed event stream — the
   * typed client grows a `.subscribe()` for it, and the schema flows into reflection. Like
   * `response`, it is **not** validated at runtime (zero hot-path cost); the server-side
   * `stream.send()` is compile-time-checked against it instead.
   */
  readonly sse?: StandardSchemaV1
  /**
   * Hook fired when the request fails `body`/`query` validation, before the handler runs. `kind` says
   * which input failed (`"body"` | `"query"`). Its return value selects one of three outcomes (may be async):
   *   - a **`Response`** → returned as-is, short-circuiting the route (custom error envelope, redirect, …).
   *   - **any other value** → treated as a repaired payload and **re-validated once** against the same
   *     schema. If it now passes, the handler runs with it; if it still fails, the original `422` stands.
   *     Re-validation means a bad return can't bypass the schema — the trust boundary holds.
   *   - **`undefined`** → give up; the original validation `422` is returned unchanged.
   * A route hook **overrides** the app-wide default set via `server({ onValidationError })`; return
   * `undefined` to fall through to the plain `422` even when an app default exists. Typical uses: a custom
   * error envelope, coercing the input, or prompting an LLM to repair the payload (re-validated, so it can't
   * bypass the schema).
   */
  readonly onValidationError?: (
    issues: ReadonlyArray<StandardIssue>,
    ctx: Context,
    kind: "body" | "query" | "params",
  ) => Response | unknown | Promise<Response | unknown>
}

/** The validated body type, or `undefined` when no body schema is declared. */
type BodyOf<S extends RouteSchema> = S extends { body: infer B extends StandardSchemaV1 }
  ? InferOutput<B>
  : undefined

/** The validated query type, or raw `URLSearchParams` when no query schema is declared. */
type QueryOf<S extends RouteSchema> = S extends { query: infer Q extends StandardSchemaV1 }
  ? InferOutput<Q>
  : URLSearchParams

/** The validated params type when a params schema is declared, else the path-inferred `Params<Path>`. */
type ParamsOf<S extends RouteSchema, Path extends string> = S extends {
  params: infer P extends StandardSchemaV1
}
  ? InferOutput<P>
  : Params<Path>

/** Mutable response controls a handler may write to before returning. */
export interface ResponseControls {
  status?: number
  readonly headers: Record<string, string>
  /**
   * Queue a `Set-Cookie` on the response. Defaults are **secure-by-default** —
   * `HttpOnly; Secure; SameSite=Lax; Path=/` — overridable per call (pass `{ secure: false }` for
   * local http dev). Multiple calls set multiple cookies (they're merged via a `Headers` object, so
   * they don't collapse the way the plain `headers` Record would). Sign the value with `signValue`
   * for tamper-evidence (what `@nifrajs/auth` sessions do).
   */
  cookie(name: string, value: string, options?: CookieOptions): void
  /** Queue a cookie deletion (`Max-Age=0` + a past `Expires`). Match the `path`/`domain` the cookie
   * was set with, or the browser keeps it. */
  deleteCookie(name: string, options?: Pick<CookieOptions, "path" | "domain">): void
}

/**
 * Runtime platform inputs, passed as `app.fetch(request, platform)`. Edge adapters (e.g.
 * Cloudflare Workers) supply `env` (bindings) + `waitUntil`; Bun/Node/Deno omit them. Optional +
 * runtime-neutral, so `app.fetch` stays a Web-standard handler.
 */
export interface Platform<Env = unknown> {
  /** Platform bindings (KV/D1/secrets on Workers). Typed as `Env` when the app declares them via
   * `server<Env>()`; otherwise `unknown` — validate before use. */
  readonly env?: Env
  /** Extend the response's lifetime for background work (Workers `ctx.waitUntil`). */
  readonly waitUntil?: (promise: Promise<unknown>) => void
  /** The raw socket peer address the serving adapter observed, if any (`listen()`, `@nifrajs/node`,
   * `@nifrajs/deno` set it). The server applies the app's `clientIp` trust declaration to this before
   * exposing {@link Context.clientIp}; read `c.clientIp`, not this. */
  readonly clientIp?: string | undefined
}

/**
 * Handler context. `params` are inferred from the path; `body` and `query` are
 * the validated outputs of their schemas when declared (else `undefined` /
 * raw `URLSearchParams`).
 */
export interface Context<Path extends string = string, S extends RouteSchema = RouteSchema> {
  readonly req: Request
  /**
   * Alias of {@link req} — the same `Request`. Page loaders/actions receive their request as `request`;
   * this alias lets route handlers and loaders share one name, so `c.request` and `ctx.req` both work
   * everywhere (no more `c.req` vs `ctx.request` mismatch).
   */
  readonly request: Request
  readonly params: ParamsOf<S, Path>
  readonly query: QueryOf<S>
  readonly body: BodyOf<S>
  /** The request's cookies, parsed from the `Cookie` header (values URL-decoded). Parsed lazily on
   * first access + cached. Signed cookies arrive as `value.signature` — verify with `unsignValue`. */
  readonly cookies: Readonly<Record<string, string>>
  readonly set: ResponseControls
  /**
   * Aborts when the server's `requestTimeoutMs` elapses (and never, when no timeout
   * is configured). Pass it to cancellation-aware work — DB drivers, `fetch` — so a
   * timed-out request stops doing work instead of running on after the 503.
   */
  readonly signal: AbortSignal
  /**
   * Absolute request deadline plus monotonic remaining time. It shares {@link signal}; the server
   * clamps an inbound deadline to local policy when `acceptInboundDeadlines` is enabled.
   */
  readonly budget: RequestBudget
  /**
   * Platform bindings from `app.fetch(request, { env })` — Workers `env` (KV/D1/secrets), etc.
   * `undefined` off-edge (Bun/Node/Deno). Declare the shape with `server<Env>()` to read it typed
   * (`c.env: Env`); otherwise `unknown`. Validate at the trust boundary before use either way.
   */
  readonly env: unknown
  /**
   * The caller's IP. By default the raw socket peer the serving adapter observed (`listen()`,
   * `@nifrajs/node`, `@nifrajs/deno`) — the one address a client cannot forge — or `undefined` when the
   * runtime exposes no socket (Workers) and no trust is declared. Behind a proxy/CDN, set the
   * `clientIp` server option (`{ trustedHops }` or `{ header }`) to derive the real caller from the
   * forwarding chain as far as you trust it; unset, no forwarded header is ever believed. Safe to key
   * rate limits and audit logs on.
   */
  readonly clientIp: string | undefined
  /**
   * Schedule background work. On edge runtimes it extends the response lifetime (Workers
   * `ctx.waitUntil`); off-edge it runs the promise fire-and-forget (a rejection is swallowed,
   * never an unhandled rejection).
   */
  readonly waitUntil: (promise: Promise<unknown>) => void
  /**
   * Read the raw request body as bytes, **capped** at `maxBytes` (default: the server's
   * `maxBodyBytes`). For routes with **no body schema** — raw bodies, file uploads,
   * BYO-validation — where the automatic schema cap doesn't apply. An over-cap body (by
   * `Content-Length` or while streaming) throws a flat `413`; a malformed `Content-Length`
   * throws `400`. Consumes the body stream (call once). Pass a larger `maxBytes` for an
   * upload route, a smaller one to tighten a specific endpoint.
   */
  readonly boundedBody: (maxBytes?: number) => Promise<Uint8Array>
  /**
   * `boundedBody` + `JSON.parse` (UTF-8). Same cap + `413`/`400` semantics; additionally
   * throws a flat `400` on invalid JSON. Use for a schema-less JSON endpoint that still
   * wants the body bounded.
   */
  readonly boundedJson: <T = unknown>(maxBytes?: number) => Promise<T>
  /**
   * Build a JSON `Response`. Pass a status number or a full `ResponseInit` as the second arg. `return` it
   * from a handler, or `throw` it from `derive`/`beforeHandle` to short-circuit — both work:
   * `throw c.json({ error: "unauthorized" }, 401)`. A terser alternative to
   * `new Response(JSON.stringify(...), { status, headers: { "content-type": "application/json" } })`.
   */
  readonly json: (body: unknown, init?: ResponseInit | number) => Response
  /** Build a `text/plain; charset=utf-8` `Response`. Like {@link json}, pass a status or `ResponseInit`. */
  readonly text: (body: string, init?: ResponseInit | number) => Response
}
