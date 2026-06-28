import type { RouteInfo, Server } from "@nifrajs/core"
import type { Jsonify } from "./jsonify.ts"
import type { Result } from "./result.ts"

/** Extract the accumulated route registry from a server's type (`typeof app`), ignoring its middleware context. */
export type RegistryOf<App> = App extends Server<infer R, infer _Ctx> ? R : never

// --- per-method call signature ---

/**
 * The `query` option's type for a route that declares NO `query` schema. It's a descriptive string
 * literal, so passing query params to such a route fails with an error that READS OUT the fix —
 * `Type '{ page: string }' is not assignable to type 'add a `query` schema…'` — instead of the opaque
 * `not assignable to type 'never'`. The error surfaces at the call site; the fix is at the route.
 */
type QueryNotTyped =
  "add a `query` schema to this route — `{ query: z.object({ … }) }` — so the typed client can accept query params here"

type CallOptions<I extends RouteInfo> = {
  query?: [I["query"]] extends [never] ? QueryNotTyped : I["query"]
  headers?: Record<string, string>
  signal?: AbortSignal
}

type IsBodyVerb<M extends string> = M extends "POST" | "PUT" | "PATCH" ? true : false

/**
 * A terminal method call. The shape is **verb-aware** so the runtime can read
 * args unambiguously with no route info: body-verbs (POST/PUT/PATCH) always take
 * the body positionally Eden-style (typed `undefined` when the route has no body
 * schema, so it's still slot 0); GET/DELETE/HEAD take only options. Returns a
 * `Result` whose data is the handler's output as it arrives over the wire
 * (`Jsonify`).
 */
type MethodCall<I extends RouteInfo, BodyVerb extends boolean> = BodyVerb extends true
  ? [I["body"]] extends [never]
    ? (body?: undefined, options?: CallOptions<I>) => Promise<Result<Jsonify<I["output"]>>>
    : (body: I["body"], options?: CallOptions<I>) => Promise<Result<Jsonify<I["output"]>>>
  : (options?: CallOptions<I>) => Promise<Result<Jsonify<I["output"]>>>

type Methods<MethodMap> = {
  [M in keyof MethodMap as Lowercase<M & string>]: MethodCall<
    MethodMap[M] & RouteInfo,
    IsBodyVerb<M & string>
  >
}

// --- path-tree construction over the registry ---

type Sub<R, Prefix extends string> = Extract<keyof R, `${Prefix}/${string}`>

type NextSeg<
  Prefix extends string,
  Path extends string,
> = Path extends `${Prefix}/${infer Seg}/${string}`
  ? Seg
  : Path extends `${Prefix}/${infer Seg}`
    ? Seg
    : never

type NextSegs<R, Prefix extends string> = {
  [P in Sub<R, Prefix> & string]: NextSeg<Prefix, P>
}[Sub<R, Prefix> & string]

// Static segments exclude params (`:`), wildcards (`*`), and the root's empty (``).
type StaticSegs<R, Prefix extends string> = Exclude<
  NextSegs<R, Prefix>,
  `:${string}` | `*${string}` | ""
>
type ParamSeg<R, Prefix extends string> = Extract<NextSegs<R, Prefix>, `:${string}` | `*${string}`>

// `unknown` (not `{}`/`never`) is the intersection identity, so empty branches
// don't poison the node — and we never `Prettify` the node (it would strip the
// param call-signature and trip TS2456 on the recursion).
type MethodsAt<R, Prefix extends string> = Prefix extends keyof R ? Methods<R[Prefix]> : unknown

type StaticChildren<R, Prefix extends string> = {
  [Seg in StaticSegs<R, Prefix> & string]: TreatyNode<R, `${Prefix}/${Seg}`>
}

type ParamChild<R, Prefix extends string> = [ParamSeg<R, Prefix>] extends [never]
  ? unknown
  : ParamSeg<R, Prefix> extends `:${infer Name}`
    ? (params: Record<Name, string>) => TreatyNode<R, `${Prefix}/:${Name}`>
    : ParamSeg<R, Prefix> extends `*${infer Name}`
      ? (
          params: Record<Name extends "" ? "*" : Name, string>,
        ) => TreatyNode<R, `${Prefix}/*${Name}`>
      : unknown

type TreatyNode<R, Prefix extends string> = MethodsAt<R, Prefix> &
  StaticChildren<R, Prefix> &
  ParamChild<R, Prefix>

// The root path "/" is reached as `api.index.get()` (Eden convention).
type RootIndex<R> = "/" extends keyof R ? { readonly index: Methods<R["/"]> } : unknown

/**
 * The Eden-style proxy type for a route registry — the shared core used by both
 * `Treaty<App>` (coupled, from `typeof app`) and `client(contract, url)`
 * (decoupled, from a contract's `RegistryFor`).
 */
export type TreatyFromRegistry<R> = TreatyNode<R, ""> & RootIndex<R>

/**
 * The Eden-style proxy type for a server. Use a named alias for readable errors:
 *
 *   type App = typeof app
 *   const api: Treaty<App> = client<App>("http://localhost:3000")
 *   await api.users({ id: "1" }).get()      // GET /users/:id
 *   await api.users.post({ name: "Ada" })   // POST /users  (body positional)
 *   await api.index.get()                   // GET /
 */
export type Treaty<App> = TreatyFromRegistry<RegistryOf<App>>
