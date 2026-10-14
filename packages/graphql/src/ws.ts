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
  type ExecutionArgs,
  type ExecutionResult,
  execute,
  GraphQLError,
  type GraphQLSchema,
  parse,
  subscribe,
  type ValidationRule,
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
  overlapLimitError,
  requestLimitError,
  validationRules,
} from "./limits.ts"

/** Per-connection state carried on `ws.data` for the graphql-ws bridge. */
interface GraphqlWsConnection {
  readonly request: Request
  /** Feed one raw inbound frame into graphql-ws (registered via its `onMessage`). */
  dispatch?: (message: string) => void | Promise<void>
  /** Tear the graphql-ws connection down (graphql-ws's `opened()` return value). */
  closed?: (code: number, reason: string) => void | Promise<void>
  readonly subscriptions: Set<string>
  /** One abort controller per running operation id, aborted by the client's complete or a close. */
  operations?: Map<string, AbortController>
  /** Set once graphql-ws sends `connection_ack`, i.e. `connection_init` was admitted. */
  acknowledged?: boolean
}

/** The `extra` graphql-ws hands its hooks for one socket. */
interface GraphqlWsExtra {
  readonly request: Request
  readonly operations: Map<string, AbortController>
}

export interface GraphqlWsOptions<
  Context extends Record<string, unknown> = Record<string, unknown>,
> {
  /** The executable schema. */
  readonly schema: GraphQLSchema
  /** Build the resolver `contextValue` from the upgrade request. Shared with the HTTP transport. */
  readonly context?: GraphqlContextBuilder<Context>
  /**
   * Admit a socket from its upgrade request, before {@link onConnect}; return `false` (or throw) to
   * reject the connection. `mountGraphql({ subscriptions: true })` passes its HTTP `authorize` here.
   */
  readonly authorize?: (request: Request) => boolean | Promise<boolean>
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
  readonly maxFieldOverlaps?: number
  readonly maxFragmentExpansion?: number
  /** Maximum concurrent subscription operation ids per connection. Default 20. */
  readonly maxSubscriptions?: number
  /**
   * Answer introspection (`__schema`, `__type`). Default `true`. Set `false` to refuse such an
   * operation with an `error` frame; `__typename` still resolves.
   */
  readonly introspection?: boolean
  /**
   * Maximum time for initial execute/subscribe setup. Default 10 seconds. Each operation's abort
   * signal, which a resolver reads through `info.getAbortSignal()`, is aborted at this deadline, when
   * the client completes the operation, and when the socket closes.
   */
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
  rules: readonly ValidationRule[],
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
  const limitError =
    documentLimitError(documentMetrics(document), limits) ?? overlapLimitError(document, limits)
  if (limitError !== undefined) return { id, message: limitError }
  const validationErrors = validate(schema, document, rules)
  return validationErrors.length > 0
    ? { id, message: validationErrors[0]?.message ?? "Invalid GraphQL query." }
    : undefined
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

/**
 * A frame graphql-ws sends, execution errors masked. A `complete` or `error` frame ends its operation,
 * so the id stops counting against `maxSubscriptions`: a client is not expected to complete an
 * operation the server already ended.
 */
function outboundFrame(message: string, connection: GraphqlWsConnection): string {
  try {
    const parsed = recordOf(JSON.parse(message))
    if (parsed === undefined) return message
    if (parsed.type === "connection_ack") connection.acknowledged = true
    if ((parsed.type === "complete" || parsed.type === "error") && typeof parsed.id === "string") {
      connection.subscriptions.delete(parsed.id)
      connection.operations?.delete(parsed.id)
    }
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

/** Close a result that arrived after its operation timed out, if it is a stream nobody will read. */
function disposeLate(result: unknown): void {
  if (typeof result !== "object" || result === null || !(Symbol.asyncIterator in result)) return
  const iterator = recordOf(result)
  if (iterator === undefined || typeof iterator.return !== "function") return
  Promise.resolve(iterator.return.call(result)).catch(() => {})
}

const wrappedSubscribeFields = new WeakSet<object>()

/**
 * graphql drops a subscribe resolver's result that settles after the operation's signal aborted, so
 * a source the resolver opened anyway would stay open. Each root subscription field's resolver is
 * wrapped once to return such a late source; with no signal, or before an abort, it is unchanged.
 */
function returnLateSources(schema: GraphQLSchema): void {
  const fields = schema.getSubscriptionType()?.getFields() ?? {}
  for (const field of Object.values(fields)) {
    const resolver = field.subscribe
    if (resolver === undefined || wrappedSubscribeFields.has(field)) continue
    wrappedSubscribeFields.add(field)
    field.subscribe = (source, args, context, info) => {
      const result = resolver(source, args, context, info)
      if (!(result instanceof Promise)) return result
      return result.then((value) => {
        if (info.getAbortSignal()?.aborted === true) disposeLate(value)
        return value
      })
    }
  }
}

/**
 * A timeout is that operation's error result. graphql-ws does not catch a rejected execute or
 * subscribe, so a rejection would end the whole socket instead of the one operation. A timeout aborts
 * the operation's `abortSignal`, which resolvers read through `info.getAbortSignal()`, and work that
 * settles after it is not abandoned open: a late subscription stream is returned.
 */
async function withWsTimeout<T>(
  start: (abortSignal: AbortSignal) => T | Promise<T>,
  outer: AbortSignal | null | undefined,
  timeoutMs: number,
): Promise<T | ExecutionResult> {
  const controller = new AbortController()
  const work = start(outer ? AbortSignal.any([outer, controller.signal]) : controller.signal)
  if (!(work instanceof Promise)) return work
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<ExecutionResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      const error = new GraphQLError("Execution timed out.")
      // Resolved first: the abort can reject the work, and the race must settle on this result.
      resolve({ errors: [error] })
      controller.abort(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (timedOut) work.then(disposeLate, () => {})
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
  const rules = validationRules(options.introspection)
  const maxSubscriptions = options.maxSubscriptions ?? 20
  assertWsNumber(maxSubscriptions, "maxSubscriptions", 1)
  const executionTimeoutMs = options.executionTimeoutMs ?? 10_000
  assertWsNumber(executionTimeoutMs, "executionTimeoutMs", 0)
  const executeWithTimeout: typeof execute = (args) =>
    executionTimeoutMs === 0
      ? execute(args)
      : withWsTimeout(
          (abortSignal) => execute({ ...args, abortSignal }),
          args.abortSignal,
          executionTimeoutMs,
        )
  const subscribeWithTimeout: typeof subscribe = (args) =>
    executionTimeoutMs === 0
      ? subscribe(args)
      : withWsTimeout(
          (abortSignal) => subscribe({ ...args, abortSignal }),
          args.abortSignal,
          executionTimeoutMs,
        )
  returnLateSources(options.schema)
  const gqlServer = makeServer<Record<string, unknown>, GraphqlWsExtra>({
    // Keep the raw escape hatch for auxiliary graphql-ws hooks, but make the package's safety
    // controls authoritative: callers cannot accidentally replace the bounded execute/subscribe
    // wrappers or the context/authentication seams with an unbounded implementation.
    ...options.serverOptions,
    schema: options.schema,
    execute: executeWithTimeout,
    subscribe: subscribeWithTimeout,
    onConnect:
      options.onConnect || options.authorize
        ? async (ctx: GraphqlWsContext<Record<string, unknown>, GraphqlWsExtra>) => {
            try {
              if (options.authorize !== undefined && !(await options.authorize(ctx.extra.request)))
                return false
              return (
                (await options.onConnect?.(
                  ctx.connectionParams as ConnectionInitMessage["payload"],
                  ctx.extra.request,
                )) ?? true
              )
            } catch {
              return false
            }
          }
        : undefined,
    // graphql-ws builds the context once per operation, just before executing it, so the operation's
    // abort signal is attached to its execution arguments here.
    context: async (
      ctx: GraphqlWsContext<Record<string, unknown>, GraphqlWsExtra>,
      id: string,
      _payload: unknown,
      args: ExecutionArgs,
    ) => {
      const controller = new AbortController()
      ctx.extra.operations.set(id, controller)
      args.abortSignal =
        args.abortSignal === undefined || args.abortSignal === null
          ? controller.signal
          : AbortSignal.any([args.abortSignal, controller.signal])
      return options.context === undefined
        ? undefined
        : await buildContext(options.context, { request: ctx.extra.request })
    },
  })

  return {
    upgrade(c: WebSocketContext): GraphqlWsConnection {
      return { request: c.req, subscriptions: new Set() }
    },

    open(ws: NifraWebSocket<GraphqlWsConnection>): void {
      const protocol =
        (ws.raw as { protocol?: string } | undefined)?.protocol ?? GRAPHQL_TRANSPORT_WS_PROTOCOL
      let onFrame: ((message: string) => void | Promise<void>) | undefined
      const operations = new Map<string, AbortController>()
      ws.data.operations = operations
      const closed = gqlServer.opened(
        {
          protocol,
          send: async (data: string) => {
            ws.send(outboundFrame(data, ws.data))
          },
          close: (code: number, reason: string) => {
            ws.close(code, reason)
          },
          onMessage: (cb) => {
            onFrame = cb
          },
        },
        { request: ws.data.request, operations },
      )
      ws.data.closed = closed
      ws.data.dispatch = async (message: string) => {
        try {
          await onFrame?.(message)
        } catch {
          // graphql-ws leaves a failed frame (a throwing context builder, say) to its socket adapter.
          // Unhandled, the rejection would end a Bun or Node process; the protocol closes one socket.
          ws.close(4500, "Internal server error")
        }
      }
    },

    message(ws: NifraWebSocket<GraphqlWsConnection>, data: string | Uint8Array): void {
      // Fire-and-forget: graphql-ws's per-message handler does not resolve until a subscription's
      // iterator completes (`await for await`), so awaiting it here would block every later frame on
      // this socket - including the client's `Complete` that stops the subscription. graphql-ws drives
      // its own sends and error frames from inside that loop; we only feed it inbound frames.
      const message = asText(data)
      // Until connection_init is admitted, graphql-ws answers a subscribe frame by closing with 4401
      // without reading the query. Parsing or validating it here would hand an unauthenticated socket
      // schema suggestions and synchronous validation work.
      const rejected =
        ws.data.acknowledged === true
          ? subscriptionFrameError(message, options.schema, limits, rules)
          : undefined
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
          ws.data.operations?.get(frame.id)?.abort(new GraphQLError("Operation completed."))
          ws.data.operations?.delete(frame.id)
        }
      } catch {
        // graphql-ws owns malformed protocol-frame handling; pass it through unchanged.
      }
      void ws.data.dispatch?.(message)
    },

    close(ws: NifraWebSocket<GraphqlWsConnection>, code: number, reason: string): void {
      ws.data.subscriptions.clear()
      for (const controller of ws.data.operations?.values() ?? [])
        controller.abort(new GraphQLError("Socket closed."))
      ws.data.operations?.clear()
      // The socket is gone: a failing iterator return() or onClose hook has no one left to answer.
      void Promise.resolve(ws.data.closed?.(code, reason)).catch(() => {})
    },
  }
}
