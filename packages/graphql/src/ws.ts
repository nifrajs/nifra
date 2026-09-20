/**
 * GraphQL subscriptions over nifra's native WebSocket lane, speaking the `graphql-transport-ws`
 * protocol (the modern `graphql-ws` wire protocol). This adapts `graphql-ws`'s transport-agnostic
 * server (`makeServer`) onto a nifra `app.ws()` route, so subscription operations run through the same
 * socket runtime as every other nifra WebSocket - no separate socket server, no second upgrade path.
 *
 * `graphql-ws` owns the per-operation async-iterator lifecycle (one `subscribe` iterator per client
 * `Subscribe` message, drained to that client's socket). The event *source* those iterators pull from
 * is yours - typically a {@link ./pubsub.ts | GraphqlPubSub}, whose in-memory reference impl mirrors
 * core's `TopicRegistry` and can be swapped for a durable bus without touching this transport.
 *
 * `graphql-ws` is an optional peer dependency: import this module only when you need subscriptions, and
 * the dependency (and its bundle weight) stays off every app that doesn't.
 */

import type { NifraWebSocket, WebSocketContext, WebSocketHandler } from "@nifrajs/core/ws"
import {
  type DocumentNode,
  execute,
  GraphQLError,
  type GraphQLSchema,
  parse,
  specifiedRules,
  subscribe,
  validate,
} from "graphql"
import {
  type ConnectionInitMessage,
  GRAPHQL_TRANSPORT_WS_PROTOCOL,
  type Context as GraphqlWsContext,
  makeServer,
  type ServerOptions,
} from "graphql-ws"
import { buildContext, type GraphqlContextBuilder } from "./context.ts"
import {
  documentLimitError,
  documentMetrics,
  type GraphqlLimits,
  graphqlLimits,
  requestLimitError,
} from "./limits.ts"

/** Per-connection state carried on `ws.data` for the graphql-ws bridge. */
interface GraphqlWsConnection {
  readonly request: Request
  /** Feed one raw inbound frame into graphql-ws (registered via its `onMessage`). */
  dispatch?: (message: string) => void | Promise<void>
  /** Tear the graphql-ws connection down (graphql-ws's `opened()` return value). */
  closed?: (code: number, reason: string) => void | Promise<void>
  readonly subscriptions: Set<string>
}

export interface GraphqlWsOptions<
  Context extends Record<string, unknown> = Record<string, unknown>,
> {
  /** The executable schema. */
  readonly schema: GraphQLSchema
  /** Build the resolver `contextValue` from the upgrade request. Shared with the HTTP transport. */
  readonly context?: GraphqlContextBuilder<Context>
  /**
   * Called once per connection with the client's `connection_init` payload; return `false` (or throw)
   * to reject the connection. The seam for authenticating a socket from an init token.
   */
  readonly onConnect?: (
    payload: ConnectionInitMessage["payload"],
    request: Request,
  ) => boolean | Promise<boolean>
  /** Additional raw `graphql-ws` server options merged last (advanced escape hatch). */
  readonly serverOptions?: Partial<ServerOptions>
  /** Same query/complexity limits as the HTTP transport. */
  readonly maxQueryBytes?: number
  readonly maxVariablesBytes?: number
  readonly maxDepth?: number
  readonly maxAliases?: number
  readonly maxComplexity?: number
  readonly maxOperations?: number
  /** Maximum concurrent subscription operation ids per connection. Default 20. */
  readonly maxSubscriptions?: number
  /** Maximum time for initial execute/subscribe setup. Default 10 seconds. */
  readonly executionTimeoutMs?: number
}

/** A frame is a string for JSON control messages; graphql-ws only speaks text frames. */
function asText(data: string | Uint8Array): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function graphqlWsLimits(options: GraphqlWsOptions): GraphqlLimits {
  return graphqlLimits(options)
}

function assertWsNumber(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`GraphQL ${name} must be a safe integer >= ${minimum}`)
  }
}

function subscriptionFrameError(
  message: string,
  schema: GraphQLSchema,
  limits: GraphqlLimits,
): { readonly id: unknown; readonly message: string } | undefined {
  let frame: unknown
  try {
    frame = JSON.parse(message)
  } catch {
    return undefined
  }
  const envelope = recordOf(frame)
  if (envelope?.type !== "subscribe") return undefined
  const id = envelope.id
  const payload = recordOf(envelope.payload)
  const query = payload?.query
  if (typeof query !== "string") return { id, message: "A subscription query is required." }
  const variablesValue = payload?.variables
  const variables =
    variablesValue === undefined || variablesValue === null ? null : recordOf(variablesValue)
  if (variablesValue !== undefined && variablesValue !== null && variables === undefined) {
    return { id, message: "Subscription variables must be an object." }
  }
  const requestError = requestLimitError(query, variables ?? null, limits)
  if (requestError !== undefined) return { id, message: requestError }
  let document: DocumentNode
  try {
    document = parse(query)
  } catch (error) {
    return { id, message: error instanceof GraphQLError ? error.message : "Invalid GraphQL query." }
  }
  const validationErrors = validate(schema, document, specifiedRules)
  if (validationErrors.length > 0)
    return { id, message: validationErrors[0]?.message ?? "Invalid GraphQL query." }
  const limitError = documentLimitError(documentMetrics(document), limits)
  return limitError === undefined ? undefined : { id, message: limitError }
}

function maskWsError(error: unknown): unknown {
  const record = recordOf(error)
  if (record === undefined) return { message: "Internal server error." }
  return {
    message: "Internal server error.",
    ...(record.locations === undefined ? {} : { locations: record.locations }),
    ...(Array.isArray(record.path) ? { path: record.path } : {}),
  }
}

function maskWsFrame(message: string): string {
  try {
    const parsed = recordOf(JSON.parse(message))
    if (parsed === undefined) return message
    if (parsed.type === "next") {
      const payload = recordOf(parsed.payload)
      if (payload !== undefined && Array.isArray(payload.errors)) {
        return JSON.stringify({
          ...parsed,
          payload: { ...payload, errors: payload.errors.map(maskWsError) },
        })
      }
    }
    if (parsed.type === "error" && Array.isArray(parsed.payload)) {
      return JSON.stringify({ ...parsed, payload: parsed.payload.map(maskWsError) })
    }
  } catch {
    return message
  }
  return message
}

async function withWsTimeout<T>(work: T | Promise<T>, timeoutMs: number): Promise<T> {
  if (!(work instanceof Promise) || timeoutMs === 0) return work
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new GraphQLError("Execution timed out.")), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Build a nifra {@link WebSocketHandler} that terminates the `graphql-transport-ws` protocol. Register
 * it on a route enabled with `.use(websocket())`:
 *
 * ```ts
 * import { websocket } from "@nifrajs/core/ws"
 * import { graphqlWebSocket } from "@nifrajs/graphql/ws"
 *
 * const app = server().use(websocket()).ws("/graphql", graphqlWebSocket({ schema, context }))
 * ```
 *
 * The route MUST negotiate the `graphql-transport-ws` subprotocol at the WebSocket layer for a browser
 * `graphql-ws` client to connect.
 */
export function graphqlWebSocket<Context extends Record<string, unknown> = Record<string, unknown>>(
  options: GraphqlWsOptions<Context>,
): WebSocketHandler<GraphqlWsConnection> {
  const limits = graphqlWsLimits(options)
  const maxSubscriptions = options.maxSubscriptions ?? 20
  assertWsNumber(maxSubscriptions, "maxSubscriptions", 1)
  const executionTimeoutMs = options.executionTimeoutMs ?? 10_000
  assertWsNumber(executionTimeoutMs, "executionTimeoutMs", 0)
  const executeWithTimeout: typeof execute = (args) =>
    withWsTimeout(execute(args), executionTimeoutMs)
  const subscribeWithTimeout: typeof subscribe = (args) =>
    withWsTimeout(subscribe(args), executionTimeoutMs)
  const gqlServer = makeServer<Record<string, unknown>, { request: Request }>({
    // Keep the raw escape hatch for auxiliary graphql-ws hooks, but make the package's safety
    // controls authoritative: callers cannot accidentally replace the bounded execute/subscribe
    // wrappers or the context/authentication seams with an unbounded implementation.
    ...options.serverOptions,
    schema: options.schema,
    execute: executeWithTimeout,
    subscribe: subscribeWithTimeout,
    onConnect: options.onConnect
      ? async (ctx: GraphqlWsContext<Record<string, unknown>, { request: Request }>) => {
          return await options.onConnect?.(
            ctx.connectionParams as ConnectionInitMessage["payload"],
            ctx.extra.request,
          )
        }
      : undefined,
    context: options.context
      ? async (ctx: GraphqlWsContext<Record<string, unknown>, { request: Request }>) =>
          await buildContext(options.context, { request: ctx.extra.request })
      : undefined,
  })

  return {
    upgrade(c: WebSocketContext): GraphqlWsConnection {
      return { request: c.req, subscriptions: new Set() }
    },

    open(ws: NifraWebSocket<GraphqlWsConnection>): void {
      const protocol =
        (ws.raw as { protocol?: string } | undefined)?.protocol ?? GRAPHQL_TRANSPORT_WS_PROTOCOL
      let onFrame: ((message: string) => void | Promise<void>) | undefined
      const closed = gqlServer.opened(
        {
          protocol,
          send: async (data: string) => {
            ws.send(maskWsFrame(data))
          },
          close: (code: number, reason: string) => {
            ws.close(code, reason)
          },
          onMessage: (cb) => {
            onFrame = cb
          },
        },
        { request: ws.data.request },
      )
      ws.data.closed = closed
      ws.data.dispatch = (message: string) => onFrame?.(message)
    },

    message(ws: NifraWebSocket<GraphqlWsConnection>, data: string | Uint8Array): void {
      // Fire-and-forget: graphql-ws's per-message handler does not resolve until a subscription's
      // iterator completes (`await for await`), so awaiting it here would block every later frame on
      // this socket - including the client's `Complete` that stops the subscription. graphql-ws drives
      // its own sends and error frames from inside that loop; we only feed it inbound frames.
      const message = asText(data)
      const rejected = subscriptionFrameError(message, options.schema, limits)
      if (rejected !== undefined) {
        ws.send(
          JSON.stringify({
            id: rejected.id,
            type: "error",
            payload: [{ message: rejected.message }],
          }),
        )
        return
      }
      try {
        const frame = recordOf(JSON.parse(message))
        if (frame?.type === "subscribe" && typeof frame.id === "string") {
          if (ws.data.subscriptions.size >= maxSubscriptions) {
            ws.send(
              JSON.stringify({
                id: frame.id,
                type: "error",
                payload: [{ message: "Subscription limit exceeded." }],
              }),
            )
            return
          }
          ws.data.subscriptions.add(frame.id)
        } else if (frame?.type === "complete" && typeof frame.id === "string") {
          ws.data.subscriptions.delete(frame.id)
        }
      } catch {
        // graphql-ws owns malformed protocol-frame handling; pass it through unchanged.
      }
      void ws.data.dispatch?.(message)
    },

    close(ws: NifraWebSocket<GraphqlWsConnection>, code: number, reason: string): void {
      ws.data.subscriptions.clear()
      void ws.data.closed?.(code, reason)
    },
  }
}
