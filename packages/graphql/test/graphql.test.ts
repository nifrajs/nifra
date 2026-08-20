import { describe, expect, test } from "bun:test"
import { buildSchema, GraphQLInt, GraphQLObjectType, GraphQLSchema, GraphQLString } from "graphql"
import { createPubSub, graphqlWebSocket, respondGraphql } from "../src/index.ts"

const schema = buildSchema(`
  type Query {
    hello: String
    whoami: String
    boom: String
  }
  type Mutation {
    echo(msg: String!): String
  }
`)

const rootValue = {
  hello: () => "world",
  whoami: (_args: unknown, ctx: { who?: string } | undefined) => ctx?.who ?? "anon",
  boom: () => {
    throw new Error("kaboom")
  },
  echo: ({ msg }: { msg: string }) => msg,
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://x/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("respondGraphql HTTP", () => {
  test("executes a query", async () => {
    const res = await respondGraphql(post({ query: "{ hello }" }), { schema, rootValue })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/graphql-response+json")
    expect(await res.json()).toEqual({ data: { hello: "world" } })
  })

  test("executes a mutation", async () => {
    const res = await respondGraphql(post({ query: 'mutation { echo(msg: "hi") }' }), {
      schema,
      rootValue,
    })
    expect(await res.json()).toEqual({ data: { echo: "hi" } })
  })

  test("field error is a 200 with data:null + errors", async () => {
    const res = await respondGraphql(post({ query: "{ boom }" }), { schema, rootValue })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown; errors: unknown[] }
    expect(body.data).toEqual({ boom: null })
    expect(body.errors).toHaveLength(1)
  })

  test("validation error is a 400", async () => {
    const res = await respondGraphql(post({ query: "{ nope }" }), { schema, rootValue })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { errors: unknown[]; data?: unknown }
    expect(body.errors).toHaveLength(1)
    expect(body.data).toBeUndefined()
  })

  test("syntax error is a 400", async () => {
    const res = await respondGraphql(post({ query: "{ hello" }), { schema, rootValue })
    expect(res.status).toBe(400)
  })

  test("missing query is a 400", async () => {
    const res = await respondGraphql(post({ variables: {} }), { schema, rootValue })
    expect(res.status).toBe(400)
  })

  test("injects nifra-derived context into resolvers", async () => {
    const res = await respondGraphql(post({ query: "{ whoami }" }), {
      schema,
      rootValue,
      context: () => ({ who: "injected" }),
    })
    expect(await res.json()).toEqual({ data: { whoami: "injected" } })
  })

  test("authorize:false short-circuits with 401", async () => {
    const res = await respondGraphql(post({ query: "{ hello }" }), {
      schema,
      rootValue,
      authorize: () => false,
    })
    expect(res.status).toBe(401)
  })

  test("body over the cap is rejected (not executed)", async () => {
    const big = "x".repeat(5000)
    const res = await respondGraphql(post({ query: "{ hello }", variables: { pad: big } }), {
      schema,
      rootValue,
      maxBodyBytes: 100,
    })
    expect(res.status).not.toBe(200)
  })

  test("legacy json mode always answers 200", async () => {
    const res = await respondGraphql(post({ query: "{ nope }" }), {
      schema,
      rootValue,
      legacyJsonResponse: true,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
  })

  test("OPTIONS preflight is 204 with CORS", async () => {
    const res = await respondGraphql(new Request("http://x/graphql", { method: "OPTIONS" }), {
      schema,
      rootValue,
    })
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
  })
})

describe("respondGraphql GET", () => {
  test("runs a query from the query string", async () => {
    const res = await respondGraphql(
      new Request("http://x/graphql?query=%7B%20hello%20%7D", { method: "GET" }),
      { schema, rootValue },
    )
    expect(await res.json()).toEqual({ data: { hello: "world" } })
  })

  test("rejects a mutation over GET with 405", async () => {
    const q = encodeURIComponent('mutation { echo(msg: "x") }')
    const res = await respondGraphql(
      new Request(`http://x/graphql?query=${q}`, { method: "GET" }),
      { schema, rootValue },
    )
    expect(res.status).toBe(405)
  })
})

// A minimal subscription schema: `count` yields 1..n from an async iterator.
function subscriptionSchema(source: () => AsyncIterableIterator<number>): GraphQLSchema {
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: { ping: { type: GraphQLString, resolve: () => "pong" } },
    }),
    subscription: new GraphQLObjectType({
      name: "Subscription",
      fields: {
        count: {
          type: GraphQLInt,
          subscribe: () => source(),
          resolve: (payload: number) => payload,
        },
      },
    }),
  })
}

describe("graphql-ws bridge + pubsub", () => {
  test("drives a subscription to completion over the nifra ws lifecycle", async () => {
    const pubsub = createPubSub<number>()
    const schemaWs = subscriptionSchema(() => pubsub.subscribe("count"))
    const handler = graphqlWebSocket({ schema: schemaWs })

    const sent: string[] = []
    const fakeWs = {
      send: (data: string | ArrayBufferView | ArrayBuffer) => {
        sent.push(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer))
      },
      close: () => {},
      readyState: 1,
      subscribe: () => {},
      unsubscribe: () => {},
      raw: { protocol: "graphql-transport-ws" },
      data: handler.upgrade!({
        req: new Request("http://x/graphql"),
        params: {},
        query: {},
        cookies: {},
        env: {},
        signal: new AbortController().signal,
        waitUntil: () => {},
        boundedBody: async () => new Uint8Array(),
        boundedJson: async () => ({}),
      } as never),
    }

    handler.open!(fakeWs as never)
    // message() is fire-and-forget (a live subscription never resolves its handler), so we drive by
    // frames + waits, not awaits.
    handler.message!(fakeWs as never, JSON.stringify({ type: "connection_init" }))
    await new Promise((r) => setTimeout(r, 5))
    handler.message!(
      fakeWs as never,
      JSON.stringify({ id: "1", type: "subscribe", payload: { query: "subscription { count }" } }),
    )
    await new Promise((r) => setTimeout(r, 5))
    pubsub.publish("count", 1)
    pubsub.publish("count", 2)
    await new Promise((r) => setTimeout(r, 20))

    const parsed = sent.map((s) => JSON.parse(s) as { type: string; payload?: { data?: unknown } })
    expect(parsed.some((m) => m.type === "connection_ack")).toBe(true)
    const nexts = parsed.filter((m) => m.type === "next")
    expect(nexts.map((m) => m.payload?.data)).toEqual([{ count: 1 }, { count: 2 }])
  })
})

// Guardrail: the transport source must never log query text / bodies (payloads stay out of a public pkg).
describe("privacy guardrail", () => {
  test("source contains no console.* calls", async () => {
    const files = ["http.ts", "ws.ts", "context.ts", "pubsub.ts", "index.ts"]
    for (const f of files) {
      const src = await Bun.file(new URL(`../src/${f}`, import.meta.url)).text()
      expect(src).not.toMatch(/console\.(log|info|warn|error|debug)/)
    }
  })
})
