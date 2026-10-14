/**
 * `@nifrajs/graphql` - mount a GraphQL endpoint on a nifra app.
 *
 * - {@link respondGraphql} (`./http.ts`) - a spec-compliant GraphQL-over-HTTP `fetch` handler.
 * - {@link graphqlWebSocket} (`./ws.ts`) - `graphql-transport-ws` subscriptions over `app.ws()`.
 * - {@link createPubSub} (`./pubsub.ts`) - an in-memory subscription source; swap for a durable bus.
 * - {@link mountGraphql} - the one-call sugar that wires POST/GET (and, optionally, subscriptions).
 *
 * It executes with `graphql`'s own `parse`/`validate`/`execute`/`subscribe`; no HTTP framework is
 * re-bundled, the request body reuses core's single bounded trust boundary, and the query text is never
 * logged. `graphql` is a required peer; `graphql-ws` is optional (needed only for subscriptions).
 */

import type { GraphqlContextBuilder, NifraContextLike } from "./context.ts"
import { type GraphqlHttpOptions, respondGraphql } from "./http.ts"
import { type GraphqlWsOptions, graphqlWebSocket } from "./ws.ts"

export type {
  GraphqlContextBuilder,
  GraphqlContextInput,
  NifraContextLike,
} from "./context.ts"
export { buildContext } from "./context.ts"
export { type GraphqlHttpOptions, respondGraphql } from "./http.ts"
export {
  createPubSub,
  type GraphqlPubSub,
  type GraphqlPubSubOptions,
  GraphqlPubSubOverflowError,
} from "./pubsub.ts"
export { type GraphqlWsOptions, graphqlWebSocket } from "./ws.ts"

/** The structural slice of a nifra server `mountGraphql` needs. Kept loose so core stays a peer dep. */
interface RouteContextLike<Env = unknown> extends NifraContextLike<Env> {
  readonly req: Request
}

interface MountableApp<Env = unknown> {
  get(path: string, handler: (c: RouteContextLike<Env>) => Response | Promise<Response>): unknown
  post(path: string, handler: (c: RouteContextLike<Env>) => Response | Promise<Response>): unknown
  ws?(path: string, handler: unknown): unknown
}

export interface MountGraphqlOptions<Context = unknown, Env = unknown>
  extends Omit<GraphqlHttpOptions<Context, Env>, "nifra"> {
  /** Endpoint path. Default `/graphql`. */
  readonly path?: string
  /** Enable `GET /graphql` (queries only). Default `true`. */
  readonly enableGet?: boolean
  /**
   * Enable `graphql-transport-ws` subscriptions on the same path. Pass `true` to reuse `schema`,
   * `context`, `authorize` (run on the upgrade request) and the query limits, or pass the WS options.
   * With `authorize` set, WS options must bring their own `authorize` or `onConnect`; the mount throws
   * otherwise, since every socket would be admitted. Requires `.use(websocket())` and `graphql-ws`.
   */
  readonly subscriptions?: boolean | GraphqlWsOptions<Record<string, unknown>>
}

type Writable<T> = { -readonly [K in keyof T]: T[K] }

const SHARED_LIMITS = [
  "maxQueryBytes",
  "maxVariablesBytes",
  "maxDepth",
  "maxAliases",
  "maxComplexity",
  "maxOperations",
  "maxFieldOverlaps",
  "maxFragmentExpansion",
  "maxFragmentComparisons",
  "executionTimeoutMs",
] as const

/** The socket transport of `subscriptions: true`: the HTTP endpoint's schema, context, authorization and limits. */
function sharedWsOptions<Context, Env>(
  options: MountGraphqlOptions<Context, Env>,
): GraphqlWsOptions<Record<string, unknown>> {
  const shared: Writable<GraphqlWsOptions<Record<string, unknown>>> = { schema: options.schema }
  const ctx = options.context as GraphqlContextBuilder<Record<string, unknown>> | undefined
  if (ctx !== undefined) shared.context = ctx
  if (options.authorize !== undefined) shared.authorize = options.authorize
  for (const limit of SHARED_LIMITS) {
    const value = options[limit]
    if (value !== undefined) shared[limit] = value
  }
  return shared
}

/**
 * Mount a GraphQL endpoint. Wires `POST` (and `GET`, unless disabled) on `path`, injecting the nifra
 * route context into your resolver context, and - when `subscriptions` is set - a `graphql-ws` WebSocket
 * on the same path.
 *
 * ```ts
 * import { server } from "@nifrajs/core"
 * import { websocket } from "@nifrajs/core/ws"
 * import { mountGraphql, createPubSub } from "@nifrajs/graphql"
 *
 * const pubsub = createPubSub()
 * const app = server().use(websocket())
 * mountGraphql(app, {
 *   schema,
 *   context: ({ nifra }) => ({ user: nifra?.env, pubsub }),
 *   subscriptions: true,
 * })
 * ```
 */
export function mountGraphql<Context = unknown, Env = unknown>(
  app: MountableApp<Env>,
  options: MountGraphqlOptions<Context, Env>,
): void {
  const path = options.path ?? "/graphql"
  const enableGet = options.enableGet !== false

  const handle = (c: RouteContextLike<Env>): Promise<Response> =>
    respondGraphql(c.req, { ...options, nifra: c })

  app.post(path, handle)
  if (enableGet) app.get(path, handle)

  if (options.subscriptions) {
    if (typeof app.ws !== "function") {
      throw new Error(
        "mountGraphql: subscriptions require a WebSocket-enabled app - call `.use(websocket())` first.",
      )
    }
    const given = options.subscriptions === true ? sharedWsOptions(options) : options.subscriptions
    // A schema hidden over HTTP stays hidden over the socket unless the WS options say otherwise.
    const wsOptions =
      options.introspection === false && given.introspection === undefined
        ? { ...given, introspection: false }
        : given
    if (
      options.authorize !== undefined &&
      wsOptions.authorize === undefined &&
      wsOptions.onConnect === undefined
    ) {
      throw new Error(
        "mountGraphql: `authorize` guards the HTTP endpoint only, and these subscription options " +
          "admit every socket. Give them their own `authorize` or `onConnect`, or pass " +
          "`subscriptions: true` to reuse `authorize`.",
      )
    }
    app.ws(path, graphqlWebSocket(wsOptions))
  }
}
