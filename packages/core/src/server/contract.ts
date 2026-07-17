import type { DataClassification } from "../classification.ts"
import { RouteConfigError } from "../errors.ts"
import { normalizeRouteCapabilities } from "../internal/capability-runtime.ts"
import { METHODS, type Method } from "../router/router.ts"
import type { InferOutput, StandardSchemaV1 } from "../schema/standard.ts"
import type { Context, IdempotencyConfig, Params, RouteSchema } from "./context.ts"
import type { EmptyRegistry, OutputOf, Registry } from "./registry.ts"
import { Server } from "./server.ts"

/** An additional (non-success) response a contract operation can document, e.g. a `404`. */
export interface ResponseDef {
  readonly description?: string
  /** Response body schema (any Standard Schema; a `t` schema yields full JSON Schema in OpenAPI). */
  readonly schema?: StandardSchemaV1
  /** Content type. Default `application/json`. */
  readonly contentType?: string
}

/**
 * One operation in a contract. Input schemas are any Standard Schema; `response` is optional.
 *
 * The fields below `response` are **optional OpenAPI metadata** — they don't affect runtime
 * validation or the inferred handler types, they enrich the document `toOpenAPI` emits. A contract is
 * the natural home for them: it's the versionable description of the API, decoupled from the impl.
 */
export interface OperationDef {
  readonly method: Method
  readonly path: string
  /** Optional path-params schema (validated + coercible at the boundary; see {@link RouteSchema.params}). */
  readonly params?: StandardSchemaV1
  readonly body?: StandardSchemaV1
  readonly query?: StandardSchemaV1
  readonly response?: StandardSchemaV1
  /** Declared effect tokens, carried into route reflection and capability assurance. */
  readonly capabilities?: readonly string[]
  /** Dedupe retries of this operation on an `Idempotency-Key` header (see {@link RouteSchema.idempotency}). */
  readonly idempotency?: IdempotencyConfig
  /** Highest data-sensitivity the response carries (see {@link RouteSchema.classification}). */
  readonly classification?: DataClassification
  /** Short summary (OpenAPI `summary`). */
  readonly summary?: string
  /** Longer description (OpenAPI `description`, CommonMark). */
  readonly description?: string
  /** Grouping tags (OpenAPI `tags`). */
  readonly tags?: readonly string[]
  /** Mark the operation deprecated. */
  readonly deprecated?: boolean
  /** Security requirements (names ref `securitySchemes`); `[]` = explicitly public. Omit ⇒ inherit the document default. */
  readonly security?: ReadonlyArray<Readonly<Record<string, readonly string[]>>>
  /** Request body content type. Default `application/json`. */
  readonly requestContentType?: string
  /** Content type of the success (`200`) response. Default `application/json`. */
  readonly responseContentType?: string
  /** Additional responses by status code, e.g. `{ "404": { description: "Not found" } }`. */
  readonly responses?: Readonly<Record<string, ResponseDef>>
}

/** A contract: named operations. Names are the handler keys and OpenAPI operationIds. */
export type ContractShape = Record<string, OperationDef>

type OpBody<O extends OperationDef> = O extends { body: infer B extends StandardSchemaV1 }
  ? InferOutput<B>
  : never
type OpQuery<O extends OperationDef> = O extends { query: infer Q extends StandardSchemaV1 }
  ? InferOutput<Q>
  : never
type OpResponse<O extends OperationDef> = O extends { response: infer R extends StandardSchemaV1 }
  ? InferOutput<R>
  : unknown

/** The body types of a contract op's declared **non-2xx** `responses` (schema-bearing ones), keyed by status. */
type OpErrorBodies<Rs extends Record<string, ResponseDef>> = {
  // Non-2xx statuses, re-keyed from the contract's string keys ("404") to number literals (404) so
  // the client's failure union discriminates on the numeric `status` it actually receives.
  [K in keyof Rs as K extends `2${string}`
    ? never
    : K extends `${infer N extends number}`
      ? N
      : never]: Rs[K] extends {
    schema: infer S extends StandardSchemaV1
  }
    ? InferOutput<S>
    : never
}

/** The client-visible error bodies for a contract op as a status-keyed record (`{ 404: Body }`), or
 * `unknown` when it declares none (mirrors an inline route with no `errors`). */
type OpErrors<O extends OperationDef> = O extends {
  responses: infer Rs extends Record<string, ResponseDef>
}
  ? [keyof OpErrorBodies<Rs>] extends [never]
    ? unknown
    : OpErrorBodies<Rs>
  : unknown

/**
 * RouteInfo as a *decoupled consumer* sees it from the contract alone: the
 * `output` is the declared `response` schema's type, or `unknown` when none is
 * declared (the consumer can't know the response without the server). Path/method
 * levels are mutable and fields are `readonly` — matching the inline registry, so
 * the two are mutually assignable.
 */
type RouteInfoForOp<O extends OperationDef> = {
  readonly params: Params<O["path"]>
  readonly query: OpQuery<O>
  readonly body: OpBody<O>
  readonly output: OpResponse<O>
  // The error union from the op's non-2xx `responses` — so a decoupled contract client sees typed error
  // bodies, just like an inline route's `errors`. `unknown` when the op declares no error responses.
  readonly errors: OpErrors<O>
  // Contract operations cannot declare an SSE event contract (yet) — `never` keeps the contract
  // registry mutually assignable with the inline registry's RouteInfoFor (mode conformance).
  readonly sse: never
}

/** Re-key the name-keyed ops into the `path → method → RouteInfo` registry. */
export type RegistryFor<C extends ContractShape> = {
  [P in C[keyof C]["path"]]: {
    [K in keyof C as C[K]["path"] extends P ? C[K]["method"] : never]: RouteInfoForOp<C[K]>
  }
}

/** The schema shape an op contributes to its handler context (mirrors inline `RouteSchema`). */
type SchemaForOp<O extends OperationDef> = (O extends { body: infer B extends StandardSchemaV1 }
  ? { body: B }
  : Record<never, never>) &
  (O extends { query: infer Q extends StandardSchemaV1 } ? { query: Q } : Record<never, never>) &
  (O extends { params: infer P extends StandardSchemaV1 } ? { params: P } : Record<never, never>)

/**
 * The handler context for an op — identical to the inline `Context<Path, S>`, so a
 * handler written for an inline route type-checks unchanged under `implement`
 * (the graduation guarantee).
 */
export type ContextForOp<O extends OperationDef> = Context<O["path"], SchemaForOp<O> & RouteSchema>

type MaybePromise<T> = T | Promise<T>

/**
 * What a handler may return for an op. When the op declares a `response`, the return is constrained to
 * that contract shape (or a raw `Response`) — so an `implement`ed backend can't drift from the response
 * the contract's client was built against. With no `response` it's unconstrained (`unknown`), identical
 * to before. Purely type-level — erased at compile time, zero runtime cost — and mirrors the inline
 * route's `ResponseOf` constraint, so a handler graduates inline↔contract unchanged.
 */
type HandlerReturnForOp<O extends OperationDef> = O extends {
  response: infer R extends StandardSchemaV1
}
  ? Response | InferOutput<R>
  : unknown

/**
 * The handlers `implement` requires: one per operation, typed from the op's input + response contract,
 * intersected with the host app's accumulated `derive`/`decorate` context - the same
 * `Context & Ctx` an inline {@link Handler} receives, so a handler graduates either way unchanged.
 */
export type HandlersFor<C extends ContractShape, Ctx = NonNullable<unknown>> = {
  [K in keyof C]: (context: ContextForOp<C[K]> & Ctx) => MaybePromise<HandlerReturnForOp<C[K]>>
}

const METHOD_SET: ReadonlySet<string> = new Set(METHODS)

/**
 * Define a standalone, versionable contract. Identity at runtime (it returns the
 * contract for type inference via the `const` type parameter, which preserves the
 * path/method literals) plus boot-time (L2) validation: each operation must use a
 * known method, a path starting with `/`, and no two operations may share a
 * `(method, path)`. Deeper path validation (param names, wildcard position) runs
 * when the contract is `implement`ed.
 */
export function defineContract<const C extends ContractShape>(contract: C): C {
  const seen = new Set<string>()
  for (const [name, op] of Object.entries(contract)) {
    const method = op.method.toUpperCase()
    if (!METHOD_SET.has(method)) {
      throw new RouteConfigError(
        "INVALID_METHOD",
        `operation "${name}": unsupported method "${op.method}"`,
      )
    }
    if (op.path.length === 0 || op.path.charCodeAt(0) !== 47 /* "/" */) {
      throw new RouteConfigError(
        "INVALID_PATH",
        `operation "${name}": path must start with "/": "${op.path}"`,
      )
    }
    const key = `${method} ${op.path}`
    if (seen.has(key)) {
      throw new RouteConfigError("DUPLICATE_ROUTE", `duplicate operation route: ${key}`)
    }
    normalizeRouteCapabilities(op.capabilities)
    seen.add(key)
  }
  return contract
}

type AnyFn = (...args: never[]) => unknown

/**
 * The registry produced by `implement`: input from the contract op; `output` is the declared `response`
 * contract when present (it wins — exactly as in the inline path), else the bound HANDLER's return — so
 * the implemented server stays route-for-route identical to the equivalent inline server (the
 * mode-conformance guarantee), and a contract-typed client and a `typeof app`-typed client agree.
 */
export type RegistryFromImpl<
  C extends ContractShape,
  H extends HandlersFor<C, Ctx>,
  Ctx = NonNullable<unknown>,
> = {
  [P in C[keyof C]["path"]]: {
    [K in keyof C as C[K]["path"] extends P ? C[K]["method"] : never]: {
      readonly params: Params<C[K]["path"]>
      readonly query: OpQuery<C[K]>
      readonly body: OpBody<C[K]>
      readonly output: C[K] extends { response: infer R extends StandardSchemaV1 }
        ? InferOutput<R>
        : H[K] extends AnyFn
          ? OutputOf<H[K]>
          : unknown
      // The error union from the op's non-2xx `responses` (see OpErrors) — a graduated contract client sees
      // the same typed error bodies as the inline `errors` path.
      readonly errors: OpErrors<C[K]>
      // Mirrors RouteInfoForOp: no SSE contract on contract ops (yet) — mode conformance holds.
      readonly sse: never
    }
  }
}

/**
 * Bind handlers to a contract, producing a real {@link Server} you can `.listen()`
 * or `.fetch()`. Each op is registered through the same path as the inline
 * builder, so the result is identical to writing the routes inline — handlers
 * lift over **unchanged** ("graduation"), and body/query schemas validate at the
 * request boundary exactly as in inline mode.
 *
 * Pass a pre-configured `app` to give the contract's routes a middleware chain. A route captures the
 * server's `derive`/`decorate`/assurance chain **at registration**, so anything applied to the
 * returned server afterwards reaches the contract's routes not at all - the app must already carry it:
 *
 * ```ts
 * const app = implement(contract, handlers, server().use(auth).derive(sessionOf))
 * ```
 *
 * That is also the seam that lets `nifra assure` prove rather than merely classify a contract-first
 * app: the plugin that installs the enforcement is what declares the evidence
 * ({@link withRouteAssurance}), and only a plugin installed *before* registration is captured. Handlers
 * then see the app's `Ctx`, and the returned server keeps any routes the app already had.
 */
export function implement<
  const C extends ContractShape,
  H extends HandlersFor<C, Ctx>,
  R extends Registry = EmptyRegistry,
  Ctx = NonNullable<unknown>,
>(contract: C, handlers: H, app?: Server<R, Ctx>): Server<R & RegistryFromImpl<C, H, Ctx>, Ctx> {
  const target = (app ?? new Server()) as Server<R, Ctx>
  const routes = Object.entries(contract).map(([name, op]) => {
    // body/query are validated at the request boundary; `response` is a type + introspection contract
    // ONLY — never validated at runtime and never read on the request hot path (the lifecycle reads
    // schema.body/query by name; the `bare`/bodyOnly/queryOnly fast-path gates ignore `response`). Built
    // once here at bind time, not per request — it just carries a reference to the op's existing schema.
    // A response-less op still yields `undefined`, byte-identical to before.
    const schema: RouteSchema | undefined =
      op.params !== undefined ||
      op.body !== undefined ||
      op.query !== undefined ||
      op.response !== undefined ||
      op.capabilities !== undefined ||
      op.idempotency !== undefined ||
      op.classification !== undefined
        ? {
            ...(op.params !== undefined ? { params: op.params } : {}),
            ...(op.body !== undefined ? { body: op.body } : {}),
            ...(op.query !== undefined ? { query: op.query } : {}),
            ...(op.response !== undefined ? { response: op.response } : {}),
            ...(op.capabilities !== undefined ? { capabilities: op.capabilities } : {}),
            ...(op.idempotency !== undefined ? { idempotency: op.idempotency } : {}),
            ...(op.classification !== undefined ? { classification: op.classification } : {}),
          }
        : undefined
    return {
      method: op.method,
      path: op.path,
      schema,
      handler: handlers[name as keyof H] as (context: never) => unknown,
    }
  })
  target.registerBatch(routes)
  // Runtime registered exactly the contract's routes through the inline path; the
  // registry type is computed from the contract inputs + handler return types.
  return target as unknown as Server<R & RegistryFromImpl<C, H, Ctx>, Ctx>
}
