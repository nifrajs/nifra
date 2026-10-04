import { describe, expect, test } from "bun:test"
import { buildSchema, parse } from "graphql"
import { graphqlWebSocket, respondGraphql } from "../src/index.ts"
import { documentMetrics } from "../src/limits.ts"

const schema = buildSchema(`
  type Query {
    hello: String
    me: Query
  }
`)

/** `F{n}` spreads `F{n-1}` twice: a few lines per level, and twice the expanded fields per level. */
function doublingFragments(levels: number): string {
  const lines = [`query { ...F${levels} }`, "fragment F0 on Query { hello }"]
  for (let level = 1; level <= levels; level++) {
    lines.push(`fragment F${level} on Query { ...F${level - 1} ...F${level - 1} }`)
  }
  return lines.join("\n")
}

describe("documentMetrics", () => {
  test("measures each fragment once, however often a document spreads it", () => {
    // 2^60 expanded fields: walking every spread in place never finishes.
    expect(documentMetrics(parse(doublingFragments(60)))).toEqual({
      operations: 1,
      depth: 1,
      aliases: 0,
      complexity: 2 ** 60,
    })
  })

  test("a shared fragment counts at every spread, at the depth it is spread", () => {
    const document = parse(`
      query { a: hello ...Pair me { ...Pair me { hello } } }
      fragment Pair on Query { hello b: hello }
    `)
    expect(documentMetrics(document)).toEqual({
      operations: 1,
      depth: 3,
      aliases: 3,
      complexity: 8,
    })
  })

  test("a fragment cycle, which validation refuses, still measures", () => {
    const document = parse(`
      query { ...A }
      fragment A on Query { hello ...B }
      fragment B on Query { hello ...A }
    `)
    expect(documentMetrics(document)).toEqual({
      operations: 1,
      depth: 1,
      aliases: 0,
      complexity: 2,
    })
  })
})

describe("a doubling-fragment document is refused by its complexity", () => {
  test("over HTTP", async () => {
    const response = await respondGraphql(
      new Request("http://x/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: doublingFragments(60) }),
      }),
      { schema, rootValue: { hello: () => "world" } },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      errors: [{ message: "GraphQL document exceeds the complexity limit of 1000." }],
    })
  })

  test("over the WebSocket", () => {
    const handler = graphqlWebSocket({ schema })
    const frames: unknown[] = []
    handler.message?.(
      {
        send: (data) => {
          frames.push(JSON.parse(String(data)))
        },
        close: () => {},
        readyState: 1,
        subscribe: () => {},
        unsubscribe: () => {},
        data: { request: new Request("http://x/graphql"), subscriptions: new Set() },
        raw: { protocol: "graphql-transport-ws" },
      },
      JSON.stringify({ id: "1", type: "subscribe", payload: { query: doublingFragments(60) } }),
    )
    expect(frames).toEqual([
      {
        id: "1",
        type: "error",
        payload: [{ message: "GraphQL document exceeds the complexity limit of 1000." }],
      },
    ])
  })
})
