import { describe, expect, test } from "bun:test"
import { GraphQLObjectType, type GraphQLResolveInfo, GraphQLSchema, GraphQLString } from "graphql"
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

// A subscription whose source arrives only when the test releases it, recording its own return().
let slowSignal: AbortSignal | undefined

// A reset outside the test body, so TypeScript does not narrow `late.signal` to undefined there.
function resetLate(): void {
  late.returned = 0
  late.signal = undefined
}

const late: { release: () => void; returned: number; signal: AbortSignal | undefined } = {
  release: () => {},
  returned: 0,
  signal: undefined,
}

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      ping: { type: GraphQLString, resolve: () => "pong" },
      slow: {
        type: GraphQLString,
        resolve: (
          _source: unknown,
          _args: unknown,
          _context: unknown,
          info: GraphQLResolveInfo,
        ) => {
          slowSignal = info.getAbortSignal()
          return new Promise((resolve) => setTimeout(() => resolve("late"), 200))
        },
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
      late: {
        type: GraphQLString,
        subscribe: (
          _source: unknown,
          _args: unknown,
          _context: unknown,
          info: GraphQLResolveInfo,
        ) =>
          new Promise<AsyncIterableIterator<string>>((resolve) => {
            late.signal = info.getAbortSignal()
            const source: AsyncIterableIterator<string> = {
              [Symbol.asyncIterator]: () => source,
              next: () => new Promise<IteratorResult<string>>(() => {}),
              return: async () => {
                late.returned++
                return { done: true, value: undefined }
              },
            }
            late.release = () => resolve(source)
          }),
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
  close(): void
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
  return {
    frames,
    closes,
    send: (frame) => handler.message?.(socket, JSON.stringify(frame)),
    close: () => handler.close?.(socket, 1000, ""),
  }
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
      expect(slowSignal?.aborted).toBe(true)
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

  test("a subscription source that arrives after its timeout is returned, not left open", async () => {
    const handler = graphqlWebSocket({ schema, executionTimeoutMs: 20 })
    late.returned = 0
    const socket = await acknowledged(handler)
    socket.send({ id: "1", type: "subscribe", payload: { query: "subscription { late }" } })
    await until(ended(socket.frames, "1"))
    expect(late.returned).toBe(0)
    expect(late.signal?.aborted).toBe(true)
    late.release()
    await until(() => late.returned === 1)
    expect(socket.closes).toEqual([])
  })

  test("a client complete aborts a subscription still setting up and returns its late source", async () => {
    const handler = graphqlWebSocket({ schema })
    resetLate()
    const socket = await acknowledged(handler)
    socket.send({ id: "1", type: "subscribe", payload: { query: "subscription { late }" } })
    await until(() => late.signal !== undefined)
    expect(late.signal?.aborted).toBe(false)
    socket.send({ id: "1", type: "complete" })
    expect(late.signal?.aborted).toBe(true)
    late.release()
    await until(() => late.returned === 1)
  })

  test("a socket close aborts a subscription still setting up and returns its late source", async () => {
    const handler = graphqlWebSocket({ schema })
    resetLate()
    const socket = await acknowledged(handler)
    socket.send({ id: "1", type: "subscribe", payload: { query: "subscription { late }" } })
    await until(() => late.signal !== undefined)
    socket.close()
    expect(late.signal?.aborted).toBe(true)
    late.release()
    await until(() => late.returned === 1)
  })
})

// graphql-ws refuses a subscribe sent before connection_init is admitted. Answering it with a
// validation error first told an unauthenticated socket the schema's field names.
describe("a subscribe frame before connection_ack", () => {
  test("gets no validation answer and closes the socket as unauthorized", async () => {
    const handler = graphqlWebSocket({ schema, onConnect: () => false })
    const socket = connect(handler)
    socket.send({ id: "1", type: "subscribe", payload: { query: "{ pin }" } })
    await until(() => socket.closes.length > 0)
    expect(socket.closes[0]?.code).toBe(4401)
    expect(socket.frames).toEqual([])
  })

  test("an admitted socket still gets the limit errors", async () => {
    const socket = await acknowledged(graphqlWebSocket({ schema }))
    socket.send({ id: "1", type: "subscribe", payload: { query: `{${" ping".repeat(100)} }` } })
    await until(ended(socket.frames, "1"))
    expect(socket.frames.at(-1)).toEqual({
      id: "1",
      type: "error",
      payload: [
        {
          message:
            "GraphQL document repeats field names in one selection set beyond the limit of 2000 same-named field pairs.",
        },
      ],
    })
  })
})
