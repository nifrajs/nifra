import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { McpDbConfigError, serveDatabaseAsMcp } from "../src/index.ts"

function seededDb(): Database {
  const db = new Database(":memory:")
  db.run("CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
  db.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, habit_id INTEGER, day TEXT)")
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)") // deliberately NOT exposed
  db.run("INSERT INTO habits (name) VALUES ('read'), ('run')")
  db.run("INSERT INTO users (email) VALUES ('secret@example.com')")
  return db
}

async function call(
  server: { fetch(request: Request): Promise<Response> },
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ text: string; isError: boolean }> {
  const response = await server.fetch(
    new Request("http://t/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  )
  const body = (await response.json()) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean }
    error?: { message?: string }
  }
  return {
    text: body.result?.content?.[0]?.text ?? body.error?.message ?? "",
    // Tool-level failures use result.isError; protocol-level ones (e.g. unknown tool) use error.
    isError: body.result?.isError === true || body.error !== undefined,
  }
}

describe("construction fails closed", () => {
  test("empty allowlist throws at boot", () => {
    expect(() => serveDatabaseAsMcp(seededDb(), { tables: [] })).toThrow(McpDbConfigError)
  })

  test("non-identifier table names throw at boot", () => {
    expect(() =>
      serveDatabaseAsMcp(seededDb(), { tables: ['habits"; DROP TABLE users; --'] }),
    ).toThrow(McpDbConfigError)
  })

  test("query_only is set on the connection — writes are rejected engine-side", () => {
    const db = seededDb()
    serveDatabaseAsMcp(db, { tables: ["habits"] })
    expect(() => db.run("INSERT INTO habits (name) VALUES ('x')")).toThrow()
  })
})

describe("schema tools", () => {
  const server = serveDatabaseAsMcp(seededDb(), { tables: ["habits", "entries"] })

  test("list_tables reports only exposed tables, with row counts", async () => {
    const { text } = await call(server, "list_tables")
    const tables = JSON.parse(text) as Array<{ table: string; rows: number }>
    expect(tables.map((t) => t.table)).toEqual(["habits", "entries"])
    expect(tables[0]?.rows).toBe(2)
    expect(text).not.toContain("users")
  })

  test("describe_table returns columns for an exposed table", async () => {
    const { text } = await call(server, "describe_table", { table: "habits" })
    const columns = JSON.parse(text) as
      | { columns: Array<{ name: string }> }
      | Array<{ name: string }>
    const names = (Array.isArray(columns) ? columns : columns.columns).map((c) => c.name)
    expect(names).toEqual(["id", "name"])
  })

  test("describe_table refuses an unexposed table", async () => {
    const result = await call(server, "describe_table", { table: "users" })
    expect(result.isError).toBe(true)
    expect(result.text).toContain("not exposed")
  })

  test("run_query is not even advertised without opt-in", async () => {
    const result = await call(server, "run_query", { sql: "SELECT 1" })
    expect(result.isError).toBe(true)
  })
})

describe("run_query (opt-in)", () => {
  const server = serveDatabaseAsMcp(seededDb(), {
    tables: ["habits", "entries"],
    runQuery: {
      authorize: ({ request }) => request.headers.get("x-key") === "s3cret",
      maxRows: 1,
    },
  })
  const auth = { "x-key": "s3cret" }

  test("unauthorized request is rejected at the transport boundary", async () => {
    const result = await call(server, "run_query", { sql: "SELECT * FROM habits" })
    expect(result.isError).toBe(true)
    expect(result.text).toBe("unauthorized")
  })

  test("authorized SELECT returns rows, capped with a truncation marker", async () => {
    const { text, isError } = await call(server, "run_query", { sql: "SELECT * FROM habits" }, auth)
    expect(isError).toBe(false)
    const result = JSON.parse(text) as {
      rows: unknown[]
      truncated?: { shown: number; total: number }
    }
    expect(result.rows).toHaveLength(1)
    expect(result.truncated).toEqual({ shown: 1, total: 2 })
  })

  test("writes are rejected (statement gate)", async () => {
    const result = await call(server, "run_query", { sql: "DELETE FROM habits" }, auth)
    expect(result.isError).toBe(true)
    expect(result.text).toContain("only SELECT")
  })

  test("multi-statement input is rejected, including after comments/strings", async () => {
    for (const sql of [
      "SELECT 1; DELETE FROM habits",
      "SELECT 1; -- x",
      "SELECT ';' ; DELETE FROM habits",
    ]) {
      const result = await call(server, "run_query", { sql }, auth)
      expect(result.isError).toBe(true)
    }
    // A literal ';' inside a string with a single statement is fine.
    const ok = await call(server, "run_query", { sql: "SELECT ';' AS s FROM habits" }, auth)
    expect(ok.isError).toBe(false)
  })

  test("a SELECT that touches an unexposed table is rejected by plan verification", async () => {
    for (const sql of [
      "SELECT * FROM users",
      "SELECT h.name FROM habits h JOIN users u ON u.id = h.id",
      "SELECT (SELECT email FROM users LIMIT 1) FROM habits",
    ]) {
      const result = await call(server, "run_query", { sql }, auth)
      expect(result.isError).toBe(true)
      expect(result.text).toContain("not exposed")
    }
  })

  test("WITH…SELECT over exposed tables works", async () => {
    const { isError, text } = await call(
      server,
      "run_query",
      { sql: "WITH h AS (SELECT name FROM habits) SELECT * FROM h LIMIT 1" },
      auth,
    )
    expect(isError).toBe(false)
    expect(text).toContain("read")
  })

  test("direct handle() dispatch of run_query fails closed (no Request to authorize)", async () => {
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "run_query", arguments: { sql: "SELECT 1" } },
    })
    const result = (response as { result?: { isError?: boolean } })?.result
    expect(result?.isError).toBe(true)
  })

  test("byte cap halves the payload until it fits", async () => {
    const db = new Database(":memory:")
    db.run("CREATE TABLE blobs (id INTEGER PRIMARY KEY, body TEXT)")
    const insert = db.prepare("INSERT INTO blobs (body) VALUES (?)")
    for (let i = 0; i < 20; i++) insert.run("x".repeat(1000))
    const tiny = serveDatabaseAsMcp(db, {
      tables: ["blobs"],
      runQuery: { authorize: () => true, maxRows: 20, maxResultBytes: 2500 },
    })
    const { text } = await call(tiny, "run_query", { sql: "SELECT * FROM blobs" })
    const result = JSON.parse(text) as {
      rows: unknown[]
      truncated?: { shown: number; total: number }
    }
    expect(result.rows.length).toBeLessThanOrEqual(2)
    expect(result.truncated?.total).toBe(20)
    expect(text.length).toBeLessThanOrEqual(3000)
  })
})
