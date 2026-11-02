import { describe, expect, test } from "bun:test"
import {
  fetchThroughCursor,
  inReadOnlyTransaction,
  type PgConnection,
  type PostgresClient,
  pgFailure,
  planReads,
  records,
} from "../src/internal/pg-exec.ts"

describe("records", () => {
  test("keeps plain objects and drops arrays, null and scalars", () => {
    expect(records([{ a: 1 }, [1, 2], null, "x", 5, undefined, { b: 2 }])).toEqual([
      { a: 1 },
      { b: 2 },
    ])
  })
})

describe("pgFailure", () => {
  const code = (error: unknown): string => pgFailure(error).code

  test("names the thrown message, not the Error wrapper", () => {
    expect(pgFailure(new Error("boom")).message).toBe("query failed: boom")
    expect(pgFailure("boom").message).toBe("query failed: boom")
    expect(pgFailure(new Error("boom"), "could not connect").message).toBe(
      "could not connect: boom",
    )
  })

  test("a thrown scalar or null is a driver failure, not a crash", () => {
    expect(code("boom")).toBe("NIFRA_DB_DRIVER")
    expect(code(null)).toBe("NIFRA_DB_DRIVER")
  })

  test("an errno that is not a five-character SQLSTATE string is a driver failure", () => {
    expect(code({ errno: 12345 })).toBe("NIFRA_DB_DRIVER")
    expect(code({ errno: "abc" })).toBe("NIFRA_DB_DRIVER")
    expect(code({ errno: "08abc" })).toBe("NIFRA_DB_DRIVER")
  })

  test("only an Error's message is read for the refusal wording", () => {
    const state = "42601"
    expect(
      code(Object.assign(new Error("cannot insert multiple commands"), { errno: state })),
    ).toBe("NIFRA_DB_WRITE_REFUSED")
    expect(code({ errno: state, message: "cannot insert multiple commands" })).toBe(
      "NIFRA_DB_QUERY_FAILED",
    )
  })
})

describe("the read-only transaction", () => {
  const client = (calls: string[] = []): PostgresClient => {
    // biome-ignore lint/plugin/noChainedTypeAssertions: the fake implements only the members the code under test calls: the template call, unsafe and release.
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the fake implements only the members the code under test calls: the template call, unsafe and release.
    const connection = Object.assign(
      () => {
        throw new Error("unexpected template call")
      },
      {
        unsafe: async (text: string) => {
          calls.push(text)
          return []
        },
        release: () => {
          calls.push("release")
        },
      },
    ) as unknown as PgConnection
    return { reserve: async () => connection, close: async () => {} }
  }

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 60,
  ])("refuses a timeout of %p", async (ms) => {
    await expect(inReadOnlyTransaction(client(), ms, async () => "ran")).rejects.toThrow(RangeError)
  })

  test("accepts one millisecond and returns what the work returned", async () => {
    const calls: string[] = []
    expect(await inReadOnlyTransaction(client(calls), 1, async () => "ran")).toBe("ran")
    expect(calls[0]).toContain("statement_timeout = 1;")
    expect(calls.at(-2)).toBe("ROLLBACK")
    expect(calls.at(-1)).toBe("release")
  })
})

describe("planReads", () => {
  const scan = (extra: Record<string, unknown> = {}) => ({
    "Node Type": "Seq Scan",
    "Relation Name": "orders",
    Schema: "public",
    Alias: "t",
    ...extra,
  })

  // `levels` wrappers put the scan at depth 2 * levels.
  const chain = (levels: number) => {
    let node: Record<string, unknown> = scan()
    for (let i = 0; i < levels; i++) node = { "Node Type": "Limit", Plans: [node] }
    return node
  }

  test("reads a scan 256 levels down and none deeper", () => {
    expect(planReads(chain(128)).relations).toEqual([{ schema: "public", name: "orders" }])
    expect(planReads(chain(129)).relations).toEqual([])
  })

  test("a bare node's own output is not a physical target list", () => {
    const reads = planReads(scan({ Output: ["t.a", "t.b"] }))
    expect(reads.outputs).toEqual([])
    expect(reads.columns.map((c) => c.column).sort()).toEqual(["a", "b"])
  })

  test("a scan without an alias is named by its relation", () => {
    const { Alias: _alias, ...bare } = scan({ Filter: "(orders.id = 1)" })
    expect(planReads(bare).columns).toEqual([
      { relation: { schema: "public", name: "orders" }, column: "id" },
    ])
  })

  test("a relation's own name is not an expression", () => {
    const reads = planReads([
      scan(),
      { "Node Type": "Seq Scan", "Relation Name": "t.secret", Schema: "public" },
    ])
    expect(reads.columns).toEqual([])
  })

  test("only a word or a star after the dot names a column", () => {
    const named = planReads(scan({ Filter: "(t + a)" }))
    expect(named.columns).toEqual([])
    expect(planReads(scan({ Filter: "(t.+ 1)" })).columns).toEqual([])
    expect(planReads(scan({ Filter: "(t. 'x')" })).columns).toEqual([])
    expect(planReads(scan({ Filter: "(t.*)" })).columns.map((c) => c.column)).toEqual(["*"])
  })

  test("a quoted dot is a name, not the dot", () => {
    expect(planReads(scan({ Filter: '(t "." a)' })).columns).toEqual([])
  })

  describe("outputs under a projecting parent", () => {
    const under = (output: string[]) =>
      planReads({
        "Node Type": "Aggregate",
        Plans: [scan({ Output: output })],
      })

    test("plain columns of one relation are listed outputs", () => {
      const reads = under(["t.a", "t.b"])
      expect(reads.outputs).toEqual([
        { relation: { schema: "public", name: "orders" }, columns: ["a", "b"] },
      ])
      expect(reads.columns).toEqual([])
    })

    test("a dropped column's NULL constant is skipped", () => {
      expect(under(["t.a", "NULL::text"]).outputs).toEqual([
        { relation: { schema: "public", name: "orders" }, columns: ["a"] },
      ])
    })

    test("an item with more than three tokens falls back to its expression", () => {
      const reads = under(["t.a::text"])
      expect(reads.outputs).toEqual([])
      expect(reads.columns.map((c) => c.column)).toEqual(["a"])
    })

    test("an operator in the dot's place is no column list", () => {
      const reads = under(["t + a"])
      expect(reads.outputs).toEqual([])
    })

    test("an unknown alias after a known one drops the whole list to expressions", () => {
      const reads = under(["t.a", "x.b"])
      expect(reads.outputs).toEqual([])
      expect(reads.columns.map((c) => c.column)).toEqual(["a"])
    })

    test("an unknown alias before a known one is not folded into it", () => {
      const reads = under(["x.a", "t.b"])
      expect(reads.outputs).toEqual([])
    })

    test("a parameter is no qualifier, even for an alias spelled like it", () => {
      const reads = planReads({
        "Node Type": "Aggregate",
        Plans: [scan({ Alias: "$1", Output: ["$1.a"] })],
      })
      expect(reads.outputs).toEqual([])
      expect(reads.columns).toEqual([])
    })

    test("an item that lexes to nothing is no column list", () => {
      expect(under([""]).outputs).toEqual([])
    })

    test("a star after the dot is read as an expression, not listed", () => {
      const reads = under(["t.*"])
      expect(reads.outputs).toEqual([])
      expect(reads.columns.map((c) => c.column)).toEqual(["*"])
    })
  })
})

describe("fetchThroughCursor", () => {
  const answer = (found: unknown[]) =>
    Object.assign(Promise.resolve(found), { values: async () => found })

  const read = (first: unknown) => {
    // biome-ignore lint/plugin/noChainedTypeAssertions: the fake implements only the members the code under test calls: the template call, unsafe and release.
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the fake implements only the members the code under test calls: the template call, unsafe and release.
    const connection = Object.assign(
      (strings: TemplateStringsArray) =>
        answer(strings[0]?.startsWith("EXPLAIN") ? [{ "QUERY PLAN": [] }] : []),
      { unsafe: () => answer([[first, "v"]]), release: () => {} },
    ) as unknown as PgConnection
    return fetchThroughCursor(connection, "SELECT 1", { maxRows: 5, scope: async () => undefined })
  }

  test("names the strings of the JSON array in the first column", async () => {
    expect(await read('["a",1,"b"]')).toEqual({ columns: ["a", "b"], rows: [["v"]] })
  })

  test("a document that is not an array names no columns", async () => {
    expect(await read('{"a":1}')).toEqual({ columns: [], rows: [["v"]] })
    expect(await read("null")).toEqual({ columns: [], rows: [["v"]] })
  })
})
