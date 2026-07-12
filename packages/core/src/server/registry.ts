import type { InferOutput, StandardSchemaV1 } from "../schema/standard.ts"
import type { Params, RouteSchema } from "./context.ts"

/**
 * One route's input/output shape as the **client** will consume it. `query`/`body`
 * are `never` when the route declares no schema for them, so the client can detect
 * "this route takes no body" via `[body] extends [never]`. `output` is the
 * handler's raw return type (the client applies `Jsonify` when reading it).
 */
export interface RouteInfo {
  // `object` is the *bound*; each route stores its precise `Params<Path>` (e.g.
  // `{ id: string }`), which a generic `Path` can't be proven to fit into
  // `Record<string, string>`. The precise type survives in the accumulated
  // registry, so exact param-key checking is preserved downstream.
  readonly params: object
  readonly query: unknown
  readonly body: unknown
  readonly output: unknown
  /** Union of the route's declared error-response body types (from `schema.errors`); `unknown` when the
   * route declares none. Surfaced by the typed client as the failure `errorData`. */
  readonly errors?: unknown
  /** The SSE event payload type (from `schema.sse`, declared via `app.sse()`); `never` for ordinary
   * routes. The typed client keys `.subscribe()` availability and its event type off this. */
  readonly sse?: unknown
}

/** The accumulated, type-level map of every route on a Server: path → method → RouteInfo. */
export type Registry = Record<string, Record<string, RouteInfo>>

/** The empty registry (no routes). `NonNullable<unknown>` is `{}` without tripping noBannedTypes. */
export type EmptyRegistry = NonNullable<unknown>

type RegistryBody<S extends RouteSchema> = S extends { body: infer B extends StandardSchemaV1 }
  ? InferOutput<B>
  : never

type RegistryQuery<S extends RouteSchema> = S extends { query: infer Q extends StandardSchemaV1 }
  ? InferOutput<Q>
  : never

/** The client-visible output: the declared `response` contract when present (so the client sees the
 * contract, not the handler's incidental return), otherwise the inferred handler output. */
type RegistryOutput<S extends RouteSchema, Output> = S extends {
  response: infer R extends StandardSchemaV1
}
  ? InferOutput<R>
  : Output

/** The union of a route's declared error-response body types (`schema.errors` → `{status: schema}`), so the
 * typed client can surface the failure body. `unknown` when the route declares no `errors`. */
type RegistryErrors<S extends RouteSchema> = S extends {
  errors: infer E extends Record<number, StandardSchemaV1>
}
  ? { [K in keyof E]: E[K] extends StandardSchemaV1 ? InferOutput<E[K]> : never }[keyof E]
  : unknown

/** The SSE event payload type from a route's `sse` schema; `never` for ordinary routes. */
type RegistrySse<S extends RouteSchema> = S extends { sse: infer E extends StandardSchemaV1 }
  ? InferOutput<E>
  : never

/** Build a {@link RouteInfo} from a route's path, schema, and handler output type. */
export type RouteInfoFor<Path extends string, S extends RouteSchema, Output> = {
  readonly params: Params<Path>
  readonly query: RegistryQuery<S>
  readonly body: RegistryBody<S>
  readonly output: RegistryOutput<S, Output>
  readonly errors: RegistryErrors<S>
  readonly sse: RegistrySse<S>
}

/** The client-visible output of a handler: its awaited return, minus raw `Response`. */
export type OutputOf<H extends (...args: never[]) => unknown> = Exclude<
  Awaited<ReturnType<H>>,
  Response
>

/**
 * Merge a new route into the registry, combining methods that share a path.
 *
 * SCALING CEILING (measured, see many-routes.test-d.ts): each chained route call nests one alias
 * level (`AddRoute<AddRoute<...`), and TypeScript resolves the whole stack lazily in ONE
 * recursion on first demand — its instantiation-depth limit fires as TS2589 at ~95-100 calls on
 * a single server. Eager-flattening variants (mapped remap, `extends infer` force, phantom
 * constraint params) were all tried and either lower the ceiling or leave spurious diagnostics —
 * the lazy first-walk is not defeatable from library code. Past ~90 routes on one app, compose
 * instead: split into domain groups and `.merge()` them (each group resolves its own short
 * stack), or use contract-first `implement()` (a single object type — no accumulation at all).
 */
export type AddRoute<
  R extends Registry,
  Method extends string,
  Path extends string,
  Info extends RouteInfo,
> = R & { [P in Path]: { [M in Method]: Info } }
