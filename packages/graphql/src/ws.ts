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
import { execute, type GraphQLSchema, subscribe } from "graphql"
import {
  type ConnectionInitMessage,
  GRAPHQL_TRANSPORT_WS_PROTOCOL,
  type Context as GraphqlWsContext,
  makeServer,
  type ServerOptions,
} from "graphql-ws"
import { buildContext, type GraphqlContextBuilder } from "./context.ts"

/** Per-connection state carried on `ws.data` for the graphql-ws bridge. */
interface GraphqlWsConnection {
  readonly request: Request
  /** Feed one raw inbound frame into graphql-ws (registered via its `onMessage`). */
  dispatch?: (message: string) => void | Promise<void>
  /** Tear the graphql-ws connection down (graphql-ws's `opened()` return value). */
  closed?: (code: number, reason: string) => void | Promise<void>
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
}

/** A frame is a string for JSON control messages; graphql-ws only speaks text frames. */
function asText(data: string | Uint8Array): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data)
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
  const gqlServer = makeServer<Record<string, unknown>, { request: Request }>({
    schema: options.schema,
    execute,
    subscribe,
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
    ...options.serverOptions,
  })

  return {
    upgrade(c: WebSocketContext): GraphqlWsConnection {
      return { request: c.req }
    },

    open(ws: NifraWebSocket<GraphqlWsConnection>): void {
      const protocol =
        (ws.raw as { protocol?: string } | undefined)?.protocol ?? GRAPHQL_TRANSPORT_WS_PROTOCOL
      let onFrame: ((message: string) => void | Promise<void>) | undefined
      const closed = gqlServer.opened(
        {
          protocol,
          send: async (data: string) => {
            ws.send(data)
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
      void ws.data.dispatch?.(asText(data))
    },

    close(ws: NifraWebSocket<GraphqlWsConnection>, code: number, reason: string): void {
      void ws.data.closed?.(code, reason)
    },
  }
}
