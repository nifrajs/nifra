import type { RouteInfo, Server } from "@nifrajs/core/server"
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
    ? (
        body?: undefined,
        options?: CallOptions<I>,
      ) => Promise<Result<Jsonify<I["output"]>, Jsonify<I["errors"]>>>
    : (
        body: I["body"],
        options?: CallOptions<I>,
      ) => Promise<Result<Jsonify<I["output"]>, Jsonify<I["errors"]>>>
  : (options?: CallOptions<I>) => Promise<Result<Jsonify<I["output"]>, Jsonify<I["errors"]>>>

// --- typed SSE subscriptions ---

/** The SSE event payload of a route (from `app.sse()`'s `sse` schema); `never` for ordinary routes. */
type SseOf<I> = I extends { sse: infer E } ? ([E] extends [never] ? never : E) : never

export interface SubscribeOptions<I extends RouteInfo> {
  query?: [I["query"]] extends [never] ? QueryNotTyped : I["query"]
  headers?: Record<string, string>
  /** Abort to close the subscription (same effect as calling `close()`). */
  signal?: AbortSignal
  /**
   * Reconnect after a dropped/errored stream (default true — EventSource semantics, so a proxy
   * closing an idle feed doesn't silently kill it). A FINITE stream should pass `false` so a clean
   * server-side end completes the subscription instead of replaying it. Delays follow exponential
   * backoff with jitter, honoring the server's `retry:` hint when sent.
   */
  reconnect?: boolean | { baseDelayMs?: number; maxDelayMs?: number }
  /** Stream-level failures (network drop, non-2xx, bad JSON). Reconnection continues regardless. */
  onError?: (error: unknown) => void
  /** The stream ended and no reconnect will follow (clean end with `reconnect: false`, or closed). */
  onClose?: () => void
}

export interface Subscription {
  /** Stop the subscription: aborts the live stream and cancels any pending reconnect. */
  close(): void
}

type SubscribeCall<I extends RouteInfo> = (
  onEvent: (event: Jsonify<SseOf<I>>) => void,
  options?: SubscribeOptions<I>,
) => Subscription

/** Routes declared via `app.sse()` grow a `.subscribe()` beside their verbs. */
type SseMethods<MethodMap> = MethodMap extends { GET: infer G }
  ? [SseOf<G>] extends [never]
    ? unknown
    : { subscribe: SubscribeCall<G & RouteInfo> }
  : unknown

// --- typed WebSocket handles ---

/** The WS frame contract of a route (from `app.ws()`'s schemas); `never` for ordinary routes. */
type WsOf<I> = I extends { ws: infer W extends { in: unknown; out: unknown } } ? W : never

export interface WsCallOptions {
  query?: Record<string, string | number | boolean>
  /** WebSocket subprotocols. A browser handshake cannot carry custom headers - authenticate via
   * `upgrade()` reading cookies/query/subprotocol, not an Authorization header. */
  protocols?: string | string[]
  /** Abort to close the socket (same effect as calling `close()`). */
  signal?: AbortSignal
  /** Socket-level failures (connection refused, abnormal close). */
  onError?: (error: unknown) => void
}

/**
 * A live typed WebSocket connection to an `app.ws()` route. `send` accepts the route's
 * `messageSchema` input type (validated server-side at the trust boundary); received frames are
 * typed from its `sendSchema` and JSON-parsed. Binary frames are not part of the typed contract
 * and are ignored by `messages()`/`onMessage` - use `raw` for them.
 */
export interface WsHandle<In, Out> {
  /** Send one typed frame (JSON-encoded). Queued until the socket opens, so it never throws. */
  send(message: In): void
  /** Async-iterate incoming typed frames. Ends when the socket closes (or `signal` aborts). */
  messages(options?: { signal?: AbortSignal }): AsyncIterableIterator<Out>
  /** Callback form of {@link messages}; returns an unsubscribe. */
  onMessage(callback: (message: Out) => void): () => void
  /** Resolves when the socket is open (rejects on a connect failure). */
  readonly opened: Promise<void>
  close(code?: number, reason?: string): void
  /** The underlying socket, for anything off the typed contract (binary frames, bufferedAmount…). */
  readonly raw: WebSocket
}

type WsCall<I extends RouteInfo> = (
  options?: WsCallOptions,
) => WsHandle<WsOf<I>["in"], Jsonify<WsOf<I>["out"]>>

/** Routes declared via `app.ws()` (pseudo-method `"WS"`) grow a `.ws()` handle. */
type WsMethods<MethodMap> = MethodMap extends { WS: infer G }
  ? [WsOf<G>] extends [never]
    ? unknown
    : { ws: WsCall<G & RouteInfo> }
  : unknown

type Methods<MethodMap> = {
  [M in Exclude<keyof MethodMap, "WS"> as Lowercase<M & string>]: MethodCall<
    MethodMap[M] & RouteInfo,
    IsBodyVerb<M & string>
  >
} & SseMethods<MethodMap> &
  WsMethods<MethodMap>

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
