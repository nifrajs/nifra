import { describe, expect, test } from "bun:test"
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from "graphql"
import { type graphqlWebSocket, mountGraphql } from "../src/index.ts"

type Handler = ReturnType<typeof graphqlWebSocket>
type Socket = Parameters<NonNullable<Handler["open"]>>[0]

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: { secret: { type: GraphQLString, resolve: () => "PROTECTED" } },
  }),
})

function mounted(options: Omit<Parameters<typeof mountGraphql>[1], "schema">) {
  const sockets = new Map<string, Handler>()
  const app = {
    get: () => undefined,
    post: () => undefined,
    ws: (path: string, handler: Handler) => sockets.set(path, handler),
  }
  mountGraphql(app, { schema, ...options })
  const handler = sockets.get("/graphql")
  if (handler === undefined) throw new Error("no socket was mounted")
  return handler
}

/** Open a socket with `headers` on its upgrade request, send `frames`, and collect what comes back. */
async function exchange(
  handler: Handler,
  headers: Record<string, string>,
  frames: readonly Record<string, unknown>[],
) {
  const sent: { readonly type: string; readonly payload?: unknown }[] = []
  const closes: (number | undefined)[] = []
  const socket: Socket = {
    send: (data) => {
      sent.push(JSON.parse(String(data)))
    },
    close: (code) => {
      closes.push(code)
    },
    readyState: 1,
    subscribe: () => {},
    unsubscribe: () => {},
    data: { request: new Request("http://x/graphql", { headers }), subscriptions: new Set() },
    raw: { protocol: "graphql-transport-ws" },
  }
  handler.open?.(socket)
  for (const frame of frames) {
    handler.message?.(socket, JSON.stringify(frame))
    // graphql-ws answers each frame asynchronously.
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { sent, closes }
}

const QUERY = { id: "1", type: "subscribe", payload: { query: "{ secret }" } }
const authorize = (request: Request) => request.headers.get("authorization") === "Bearer ok"

describe("mountGraphql subscriptions", () => {
  test("`subscriptions: true` runs the HTTP authorize on the upgrade request", async () => {
    const handler = mounted({ authorize, subscriptions: true })
    const refused = await exchange(handler, {}, [{ type: "connection_init" }, QUERY])
    expect(refused.closes[0]).toBe(4403)
    expect(JSON.stringify(refused.sent)).not.toContain("PROTECTED")

    const admitted = await exchange(handler, { authorization: "Bearer ok" }, [
      { type: "connection_init" },
      QUERY,
    ])
    expect(admitted.sent.map((frame) => frame.type)).toEqual(["connection_ack", "next", "complete"])
  })

  test("`subscriptions: true` carries the HTTP query limits", async () => {
    const handler = mounted({ maxQueryBytes: 4, subscriptions: true })
    const { sent } = await exchange(handler, {}, [{ type: "connection_init" }, QUERY])
    expect(sent.map((frame) => frame.type)).toEqual(["connection_ack", "error"])
  })

  test("subscription options without their own admission are refused when HTTP is authorized", () => {
    expect(() => mounted({ authorize, subscriptions: { schema } })).toThrow(
      /`authorize` guards the HTTP endpoint only/,
    )
    expect(() =>
      mounted({ authorize, subscriptions: { schema, onConnect: () => true } }),
    ).not.toThrow()
    expect(() => mounted({ subscriptions: { schema } })).not.toThrow()
  })
})
