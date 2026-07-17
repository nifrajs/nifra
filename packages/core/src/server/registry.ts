import type { InferInput, InferOutput, StandardSchemaV1 } from "../schema/standard.ts"
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
  /** The route's declared error bodies as a status-keyed record (from `schema.errors`, e.g.
   * `{ 404: NotFound }`); `unknown` when the route declares none. The typed client turns this into
   * a status-discriminated failure union. */
  readonly errors?: unknown
  /** The SSE event payload type (from `schema.sse`, declared via `app.sse()`); `never` for ordinary
   * routes. The typed client keys `.subscribe()` availability and its event type off this. */
  readonly sse?: unknown
  /** The WebSocket message contract (from `app.ws()`'s `messageSchema`/`sendSchema`): `in` is what the
   * client may send, `out` what the server pushes. Present only on WS entries (method key `"WS"`);
   * the typed client keys `.ws()` availability and its frame types off this. */
  readonly ws?: unknown
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

/** A route's declared error-response body types as a STATUS-KEYED record (`schema.errors` →
 * `{ 404: NotFound, 409: Conflict }`), so the typed client can discriminate the failure body by
 * `status`, not just surface a union. `unknown` when the route declares no `errors`. */
type RegistryErrors<S extends RouteSchema> = S extends {
  errors: infer E extends Record<number, StandardSchemaV1>
}
  ? { [K in keyof E]: E[K] extends StandardSchemaV1 ? InferOutput<E[K]> : never }
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
 * The registry entry for a WebSocket route (stored under the pseudo-method key `"WS"`, so WS routes
 * ride the same path → method map as HTTP routes - no extra Server generic). `in` is the client →
 * server frame type: the `messageSchema`'s INPUT side, since that is what goes on the wire before
 * validation transforms it. `out` is the server → client frame type from `sendSchema` (a type-level
 * contract; the server's own sends are not runtime-validated). Either is `unknown` when undeclared.
 */
export type WsRouteInfoFor<
  Path extends string,
  In extends StandardSchemaV1 | undefined,
  Out extends StandardSchemaV1 | undefined,
> = {
  readonly params: Params<Path>
  readonly query: never
  readonly body: never
  readonly output: never
  readonly errors: unknown
  readonly sse: never
  readonly ws: {
    readonly in: In extends StandardSchemaV1 ? InferInput<In> : unknown
    readonly out: Out extends StandardSchemaV1 ? InferOutput<Out> : unknown
  }
}

/**
 * Merge a new route into the registry, combining methods that share a path.
 *
 * SCALING CEILING (measured — see many-routes.test-d.ts and the isolation study below): a single
 * fluent chain hits TS2589 at ~95-100 routes. This intersection is NOT the cause — in isolation it
 * accumulates 1000+ routes cleanly, and heavy per-route `Params<Path>`/schema inference alone
 * reaches 600+. The wall is an INTERACTION unique to the fluent builder: each `.get(path, handler)`
 * both (a) computes the handler's context type from the path (`c.params.id` inferred from `:id`)
 * AND (b) returns `Server<AddRoute<growing-R, …>, Ctx>`. Neither alone strains the compiler; the
 * PRODUCT — recomputing the handler context while re-threading the ever-larger registry at each of
 * N steps — exhausts TypeScript's per-expression instantiation budget around N≈95. It is therefore
 * O(N) and inherent to any builder that infers handler context AND accumulates a typed route
 * registry (Elysia/tRPC/hono's typed clients cap the same way); it is not fixable by reshaping
 * AddRoute. Past ~90 routes, use a path that DOESN'T form the product: split into domain groups and
 * `.merge()` them (each group is a short chain; a merge is one `R & R2` intersection with no
 * per-call context work), or contract-first `implement()` (the registry is one object type declared
 * upfront — no grow-R-per-call, so no ceiling at all).
 */
export type AddRoute<
  R extends Registry,
  Method extends string,
  Path extends string,
  Info extends RouteInfo,
> = R & { [P in Path]: { [M in Method]: Info } }
