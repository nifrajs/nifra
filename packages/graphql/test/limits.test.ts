import { describe, expect, test } from "bun:test"
import { buildSchema, parse } from "graphql"
import { graphqlWebSocket, respondGraphql } from "../src/index.ts"
import { documentMetrics, fieldOverlaps, fragmentComparisons } from "../src/limits.ts"

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
    const { fragmentExpansion, ...metrics } = documentMetrics(parse(doublingFragments(60)))
    expect(metrics).toEqual({ operations: 1, depth: 1, aliases: 0, complexity: 2 ** 60 })
    expect(fragmentExpansion).toBeGreaterThan(2 ** 60)
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
      fragmentExpansion: 4,
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
      fragmentExpansion: 6,
    })
  })

  test("fragment expansion grows with the square of a chain or a nesting, not with its fields", () => {
    expect(documentMetrics(parse(fragmentChain(4))).fragmentExpansion).toBe(4 + 6)
    expect(documentMetrics(parse(nestedInlineFragments(4))).fragmentExpansion).toBe(10)
    expect(documentMetrics(parse("{ hello me { hello } }")).fragmentExpansion).toBe(0)
  })
})

/** `{ ...f0 }` then `f{i}` spreading `f{i+1}`, the last selecting one field: compact, depth 1. */
function fragmentChain(n: number): string {
  let query = "{...f0}"
  for (let i = 0; i < n - 1; i++) query += `fragment f${i} on Query{...f${i + 1}}`
  return `${query}fragment f${n - 1} on Query{hello}`
}

const nestedInlineFragments = (n: number): string =>
  `{${"...on Query{".repeat(n)}hello${"}".repeat(n)}}`

// Both fit the 64 KiB query limit at depth 1 and complexity 1, and validation (and, for the nesting,
// the overlap count before it) held the event loop for hundreds of milliseconds per request.
describe("fragment chains and nested inline fragments are bounded before validation", () => {
  const post = (query: string, options: { maxFragmentExpansion?: number } = {}) =>
    respondGraphql(
      new Request("http://x/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      }),
      { schema, rootValue: { hello: () => "world" }, ...options },
    )
  const refusal = {
    errors: [
      { message: "GraphQL document expands fragments beyond the limit of 20000 selections." },
    ],
  }

  test("a long fragment chain is refused", async () => {
    const response = await post(fragmentChain(1000))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(refusal)
  })

  test("deeply nested inline fragments are refused", async () => {
    const response = await post(nestedInlineFragments(4000))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(refusal)
  })

  test("a short chain still runs, and the limit is configurable", async () => {
    const ok = await post(fragmentChain(20))
    expect(await ok.json()).toEqual({ data: { hello: "world" } })
    const tight = await post(fragmentChain(20), { maxFragmentExpansion: 100 })
    expect(tight.status).toBe(400)
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
        // A socket whose connection_init graphql-ws already admitted.
        data: {
          request: new Request("http://x/graphql"),
          subscriptions: new Set(),
          acknowledged: true,
        },
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

// graphql-js compares every two same-named fields in one selection set during validation. A few
// kilobytes of them held the event loop for seconds before any limit ran.
describe("same-named fields are bounded before validation", () => {
  const post = (query: string, options: { maxFieldOverlaps?: number } = {}) =>
    respondGraphql(
      new Request("http://x/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      }),
      { schema, rootValue: { hello: () => "world" }, ...options },
    )
  const repeated = (n: number) => `{${" hello".repeat(n)} }`
  const overlapRefusal = {
    errors: [
      {
        message:
          "GraphQL document repeats field names in one selection set beyond the limit of 2000 same-named field pairs.",
      },
    ],
  }

  test("pairs are counted per selection set, through inline fragments and spreads", () => {
    expect(fieldOverlaps(parse(repeated(3)))).toBe(3)
    expect(
      fieldOverlaps(parse("{ hello ... on Query { hello } ...F } fragment F on Query { hello }")),
    ).toBe(3)
    expect(fieldOverlaps(parse("{ me { hello } me { hello } }"))).toBe(1)
  })

  test("a repeated field beyond the limit is refused without validating", async () => {
    const response = await post(repeated(100))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(overlapRefusal)
  })

  test("fields brought in by many fragment spreads count too", async () => {
    const fragments = Array.from({ length: 70 }, (_, i) => `fragment F${i} on Query { hello }`)
    const spreads = fragments.map((_, i) => `...F${i}`).join(" ")
    const response = await post(`{ ${spreads} } ${fragments.join(" ")}`)
    expect(await response.json()).toEqual(overlapRefusal)
  })

  test("an unused fragment is refused before validation", async () => {
    const response = await post(`{ hello } fragment Unused on Query { ${" hello".repeat(300)} }`)
    expect(await response.json()).toEqual({
      errors: [{ message: 'Fragment "Unused" is never used.' }],
    })
  })

  test("maxFieldOverlaps raises the bound", async () => {
    const response = await post(repeated(100), { maxFieldOverlaps: 5_000 })
    expect(response.status).toBe(200)
  })
})

const postTo = (
  target: ReturnType<typeof buildSchema>,
  query: string,
  options: { maxFragmentComparisons?: number } = {},
) =>
  respondGraphql(
    new Request("http://x/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
    { schema: target, rootValue: { hello: () => "world" }, ...options },
  )

/** `{ ...A0 ... ...A{n-1} }` with `A{i}`'s body from `body`. */
function spreads(n: number, body: (name: string, index: number) => string): string {
  const names = Array.from({ length: n }, (_, i) => `A${i}`)
  const fragments = names.map((name, i) => `fragment ${name} on Query{${body(name, i)}}`)
  return `{${names.map((name) => `...${name}`).join(" ")}} ${fragments.join(" ")}`
}

// A fragment that reaches no field reads zero on complexity, depth and field pairs, while
// graphql-js compared every pair of spreads before reporting the fragment: 1,800 of them in 64 KiB
// held the event loop for about 400 ms.
describe("fragments that reach no field are refused before validation", () => {
  test("a spread of an unknown fragment", async () => {
    const response = await postTo(
      schema,
      spreads(1500, () => "...Z"),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ errors: [{ message: 'Unknown fragment "Z".' }] })
  })

  test("over the WebSocket too", () => {
    const frames: unknown[] = []
    graphqlWebSocket({ schema }).message?.(
      {
        send: (data) => {
          frames.push(JSON.parse(String(data)))
        },
        close: () => {},
        readyState: 1,
        subscribe: () => {},
        unsubscribe: () => {},
        data: {
          request: new Request("http://x/graphql"),
          subscriptions: new Set(),
          acknowledged: true,
        },
        raw: { protocol: "graphql-transport-ws" },
      },
      JSON.stringify({
        id: "1",
        type: "subscribe",
        payload: { query: spreads(1500, () => "...Z") },
      }),
    )
    expect(frames).toEqual([
      { id: "1", type: "error", payload: [{ message: 'Unknown fragment "Z".' }] },
    ])
  })

  test("a fragment that spreads itself, or a cycle through another", async () => {
    const self = await postTo(
      schema,
      spreads(1500, (name) => `...${name}`),
    )
    expect(await self.json()).toEqual({
      errors: [{ message: 'Cannot spread fragment "A0" within itself.' }],
    })
    const cycle = await postTo(schema, "{...A} fragment A on Query{...B} fragment B on Query{...A}")
    expect(await cycle.json()).toEqual({
      errors: [{ message: 'Cannot spread fragment "A" within itself.' }],
    })
  })
})

describe("fragment comparisons are bounded before validation", () => {
  const wide = buildSchema(
    `type Query { hello: String ${Array.from({ length: 500 }, (_, i) => `f${i}: Int`).join(" ")} }`,
  )
  const distinct = (n: number): string => spreads(n, (_, i) => `f${i}`)

  test("each spread counts against the fields of the set holding it, each pair of spreads once", () => {
    expect(fragmentComparisons(parse(distinct(3)), 1_000)).toBe(6)
    expect(
      fragmentComparisons(
        parse(
          "{...A ...B} fragment A on Query{...C} fragment B on Query{f1} fragment C on Query{f2}",
        ),
        1_000,
      ),
    ).toBe(6)
  })

  test("counting stops just past the budget", () => {
    expect(fragmentComparisons(parse(distinct(500)), 1_000)).toBe(1_001)
  })

  test("many fragments that each select a distinct field are refused, and the limit is configurable", async () => {
    const response = await postTo(wide, distinct(500))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      errors: [
        { message: "GraphQL document compares fragments beyond the limit of 100000 comparisons." },
      ],
    })
    const raised = await postTo(wide, distinct(500), { maxFragmentComparisons: 200_000 })
    expect(raised.status).toBe(200)
  })

  test("a binary tree of 255 fragments still validates", async () => {
    const definitions: string[] = []
    let id = 0
    const build = (depth: number): string => {
      const name = `T${id++}`
      if (depth === 0) definitions.push(`fragment ${name} on Query{f${id}}`)
      else
        definitions.push(`fragment ${name} on Query{...${build(depth - 1)} ...${build(depth - 1)}}`)
      return name
    }
    const root = build(7)
    expect((await postTo(wide, `{...${root}} ${definitions.join(" ")}`)).status).toBe(200)
  })
})
