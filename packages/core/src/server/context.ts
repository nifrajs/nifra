import type { InferOutput, StandardSchemaV1 } from "../schema/standard.ts"
import type { CookieOptions } from "./cookies.ts"

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
  readonly body?: StandardSchemaV1
  readonly query?: StandardSchemaV1
  /** Optional **response contract**. When declared: the handler's return is type-checked against it
   * (the implementation can't drift from the contract), the typed client sees THIS as the response type
   * (the contract — not the handler's incidental return), and it's emitted into OpenAPI/JSON-Schema so
   * tooling and coding agents can read the exact shape. It is **not** validated at runtime (zero
   * hot-path cost) — purely a compile-time + introspection contract. */
  readonly response?: StandardSchemaV1
}

/** The validated body type, or `undefined` when no body schema is declared. */
type BodyOf<S extends RouteSchema> = S extends { body: infer B extends StandardSchemaV1 }
  ? InferOutput<B>
  : undefined

/** The validated query type, or raw `URLSearchParams` when no query schema is declared. */
type QueryOf<S extends RouteSchema> = S extends { query: infer Q extends StandardSchemaV1 }
  ? InferOutput<Q>
  : URLSearchParams

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
}

/**
 * Handler context. `params` are inferred from the path; `body` and `query` are
 * the validated outputs of their schemas when declared (else `undefined` /
 * raw `URLSearchParams`).
 */
export interface Context<Path extends string = string, S extends RouteSchema = RouteSchema> {
  readonly req: Request
  readonly params: Params<Path>
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
   * Platform bindings from `app.fetch(request, { env })` — Workers `env` (KV/D1/secrets), etc.
   * `undefined` off-edge (Bun/Node/Deno). Declare the shape with `server<Env>()` to read it typed
   * (`c.env: Env`); otherwise `unknown`. Validate at the trust boundary before use either way.
   */
  readonly env: unknown
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
}
