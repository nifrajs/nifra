import { describe, expect, test } from "bun:test"
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from "graphql"
import { createPubSub, graphqlWebSocket } from "../src/index.ts"

type Handler = ReturnType<typeof graphqlWebSocket>
type Socket = Parameters<NonNullable<Handler["open"]>>[0]

interface Frame {
  readonly id?: string
  readonly type: string
  readonly payload?: unknown
}

// Nothing is ever published, so a subscription to it stays live until the client completes it.
const quiet = createPubSub<string>()

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      ping: { type: GraphQLString, resolve: () => "pong" },
      slow: {
        type: GraphQLString,
        resolve: () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
      },
    },
  }),
  subscription: new GraphQLObjectType({
    name: "Subscription",
    fields: {
      live: {
        type: GraphQLString,
        subscribe: () => quiet.subscribe("live"),
        resolve: (payload: string) => payload,
      },
      broken: {
        type: GraphQLString,
        subscribe: async function* () {
          yield* []
          throw new Error("source went away")
        },
      },
    },
  }),
})

/** A socket the handler drives, recording what it sends and how it closes. */
function connect(handler: Handler): {
  readonly frames: Frame[]
  readonly closes: { readonly code: number | undefined; readonly reason: string | undefined }[]
  send(frame: Record<string, unknown>): void
} {
  const frames: Frame[] = []
  const closes: { code: number | undefined; reason: string | undefined }[] = []
  const socket: Socket = {
    send: (data) => {
      frames.push(JSON.parse(String(data)))
    },
    close: (code, reason) => {
      closes.push({ code, reason })
    },
    readyState: 1,
    subscribe: () => {},
    unsubscribe: () => {},
    data: { request: new Request("http://x/graphql"), subscriptions: new Set() },
    raw: { protocol: "graphql-transport-ws" },
  }
  handler.open?.(socket)
  return { frames, closes, send: (frame) => handler.message?.(socket, JSON.stringify(frame)) }
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the socket")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const ended = (frames: readonly Frame[], id: string) => () =>
  frames.some((frame) => frame.id === id && (frame.type === "complete" || frame.type === "error"))

async function acknowledged(handler: Handler): Promise<ReturnType<typeof connect>> {
  const socket = connect(handler)
  socket.send({ type: "connection_init" })
  await until(() => socket.frames.some((frame) => frame.type === "connection_ack"))
  return socket
}

describe("graphql-ws operation slots", () => {
  test("an operation the server completes frees its slot", async () => {
    const socket = await acknowledged(graphqlWebSocket({ schema, maxSubscriptions: 2 }))
    for (const id of ["1", "2", "3", "4"]) {
      socket.send({ id, type: "subscribe", payload: { query: "{ ping }" } })
      await until(ended(socket.frames, id))
    }
    expect(socket.frames.filter((frame) => frame.type === "error")).toEqual([])
    expect(socket.frames.filter((frame) => frame.type === "complete").length).toBe(4)
  })

  test("an operation the server ends with an error frees its slot", async () => {
    const socket = await acknowledged(graphqlWebSocket({ schema, maxSubscriptions: 1 }))
    socket.send({ id: "1", type: "subscribe", payload: { query: "subscription { broken }" } })
    await until(ended(socket.frames, "1"))
    socket.send({ id: "2", type: "subscribe", payload: { query: "{ ping }" } })
    await until(ended(socket.frames, "2"))
    expect(socket.frames.filter((frame) => frame.id === "2")).toEqual([
      { id: "2", type: "next", payload: { data: { ping: "pong" } } },
      { id: "2", type: "complete" },
    ])
  })

  test("a live subscription holds its slot until the client completes it", async () => {
    const socket = await acknowledged(graphqlWebSocket({ schema, maxSubscriptions: 1 }))
    socket.send({ id: "1", type: "subscribe", payload: { query: "subscription { live }" } })
    socket.send({ id: "2", type: "subscribe", payload: { query: "{ ping }" } })
    expect(socket.frames.filter((frame) => frame.id === "2")).toEqual([
      { id: "2", type: "error", payload: [{ message: "Subscription limit exceeded." }] },
    ])
    socket.send({ id: "1", type: "complete" })
    socket.send({ id: "3", type: "subscribe", payload: { query: "{ ping }" } })
    await until(ended(socket.frames, "3"))
    expect(socket.frames.filter((frame) => frame.id === "3").map((frame) => frame.type)).toEqual([
      "next",
      "complete",
    ])
  })
})

/** Bun and Node end the process on an unhandled rejection, so each failure must land on its socket. */
async function unhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const record = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on("unhandledRejection", record)
  try {
    await run()
    await new Promise((resolve) => setTimeout(resolve, 10))
  } finally {
    process.off("unhandledRejection", record)
  }
  return seen
}

describe("graphql-ws failures stay on the socket", () => {
  test("an onConnect that throws refuses the connection", async () => {
    const handler = graphqlWebSocket({
      schema,
      onConnect: () => {
        throw new Error("bad token")
      },
    })
    const socket = connect(handler)
    const unhandled = await unhandledRejections(async () => {
      socket.send({ type: "connection_init", payload: { token: "nope" } })
      await until(() => socket.closes.length > 0)
    })
    expect(unhandled).toEqual([])
    expect(socket.closes).toEqual([{ code: 4403, reason: "Forbidden" }])
  })

  test("a context builder that throws closes that socket as an internal error", async () => {
    const handler = graphqlWebSocket({
      schema,
      context: () => {
        throw new Error("store unavailable")
      },
    })
    const unhandled = await unhandledRejections(async () => {
      const socket = await acknowledged(handler)
      socket.send({ id: "1", type: "subscribe", payload: { query: "{ ping }" } })
      await until(() => socket.closes.length > 0)
      expect(socket.closes).toEqual([{ code: 4500, reason: "Internal server error" }])
    })
    expect(unhandled).toEqual([])
  })

  test("an operation past executionTimeoutMs fails alone and the socket stays open", async () => {
    const handler = graphqlWebSocket({ schema, executionTimeoutMs: 20 })
    const unhandled = await unhandledRejections(async () => {
      const socket = await acknowledged(handler)
      socket.send({ id: "1", type: "subscribe", payload: { query: "{ slow }" } })
      await until(ended(socket.frames, "1"))
      socket.send({ id: "2", type: "subscribe", payload: { query: "{ ping }" } })
      await until(ended(socket.frames, "2"))
      expect(socket.frames.filter((frame) => frame.id === "1")).toEqual([
        { id: "1", type: "next", payload: { errors: [{ message: "Internal server error." }] } },
        { id: "1", type: "complete" },
      ])
      expect(socket.frames.filter((frame) => frame.id === "2").map((frame) => frame.type)).toEqual([
        "next",
        "complete",
      ])
      expect(socket.closes).toEqual([])
    })
    expect(unhandled).toEqual([])
  })
})
