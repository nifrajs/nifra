import { Database } from "bun:sqlite"
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveDatabaseAsMcp } from "../src/index.ts"

const scratch = mkdtempSync(join(tmpdir(), "nifra-mcp-db-refusals-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

async function call(
  server: { fetch(request: Request): Promise<Response> },
  sql: string,
): Promise<{ text: string; isError: boolean }> {
  const response = await server.fetch(
    new Request("http://t/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_query", arguments: { sql } },
      }),
    }),
  )
  const result = field(await response.json(), "result")
  const first = field(field(result, "content"), "0")
  return { text: String(field(first, "text") ?? ""), isError: field(result, "isError") === true }
}

function seeded(): Database {
  const db = new Database(":memory:")
  db.run("CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)")
  db.run("CREATE VIEW leaky AS SELECT email FROM users")
  db.run("INSERT INTO habits (name) VALUES ('read'), ('run')")
  db.run("INSERT INTO users (email) VALUES ('secret@example.com')")
  return db
}

test("an allowlisted view that reads an unexposed table is refused by the plan check", async () => {
  const server = serveDatabaseAsMcp(seeded(), {
    tables: ["habits", "leaky"],
    runQuery: { authorize: () => true },
  })
  const { isError, text } = await call(server, "SELECT * FROM leaky")
  expect(isError).toBe(true)
  expect(text).toBe('query touches "users", which is not exposed')
  expect(text).not.toContain("secret@example.com")
})

test("a result that cannot fit maxResultBytes even with no rows is refused", async () => {
  const server = serveDatabaseAsMcp(seeded(), {
    tables: ["habits"],
    runQuery: { authorize: () => true, maxResultBytes: 1 },
  })
  expect(await call(server, "SELECT * FROM habits")).toEqual({
    isError: true,
    text: "query result exceeds maxResultBytes",
  })
})

test("handle() dispatches tools other than run_query to the server", async () => {
  const server = serveDatabaseAsMcp(seeded(), {
    tables: ["habits"],
    runQuery: { authorize: () => true },
  })
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  const tools = field(field(response, "result"), "tools")
  const names = Array.isArray(tools) ? tools.map((tool) => field(tool, "name")) : []
  expect(names).toEqual(["list_tables", "describe_table", "run_query"])
})

test("a query beyond maxConcurrentQueries is refused while another runs", async () => {
  const file = join(scratch, "concurrent.db")
  const writer = new Database(file)
  writer.run("CREATE TABLE a (id INTEGER PRIMARY KEY)")
  writer.run("CREATE TABLE b (id INTEGER PRIMARY KEY)")
  writer.run(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO a SELECT i FROM n",
  )
  writer.run("INSERT INTO b SELECT id FROM a")
  writer.close()
  const db = new Database(file, { readonly: true })
  const server = serveDatabaseAsMcp(db, {
    tables: ["a", "b"],
    // The join takes 0.3 s on a Windows runner and over 7 s on a slow one; the deadline is not under
    // test, and at its 5 s default it raced the test's own timeout.
    runQuery: { authorize: () => true, maxConcurrentQueries: 1, queryTimeoutMs: 30_000 },
  })
  try {
    // The first call is answered by the worker, so the second reaches the handler while it is open.
    const [slow, refused] = await Promise.all([
      call(server, "SELECT count(*) AS n FROM a JOIN b"),
      call(server, "SELECT 1 FROM a LIMIT 1"),
    ])
    expect(slow.isError).toBe(false)
    expect(refused).toEqual({ isError: true, text: "too many concurrent queries" })
  } finally {
    await server.close?.()
    db.close()
  }
}, 60_000)

test("a statement that fails while running is reported as a query error", async () => {
  const server = serveDatabaseAsMcp(seeded(), {
    tables: ["habits"],
    runQuery: { authorize: () => true },
  })
  const { isError, text } = await call(server, "SELECT abs(-9223372036854775808) AS n FROM habits")
  expect(isError).toBe(true)
  expect(text).toStartWith("query failed: ")
  expect(text).toContain("integer overflow")
})

// A driver shape with column names, whose result read and row count the test controls.
function scripted(options: {
  readonly onRead?: () => void
  readonly count?: () => unknown
}): Parameters<typeof serveDatabaseAsMcp>[0] {
  return {
    run: () => undefined,
    prepare: (sql: string) => ({
      columnNames: ["n"],
      all: () => {
        if (sql.startsWith("EXPLAIN") || sql.includes("sqlite_master")) return []
        if (sql.includes("__nifra_total")) return [{ __nifra_total: options.count?.() }]
        options.onRead?.()
        return [1, 2, 3].map((n) => ({ n, __nifra_row_bytes: 1 }))
      },
    }),
  }
}

test("an in-process read that overruns the deadline is reported once it returns", async () => {
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    const server = serveDatabaseAsMcp(
      scripted({
        onRead: () => {
          now += 60_000
        },
      }),
      { tables: ["habits"], runQuery: { authorize: () => true } },
    )
    expect(await call(server, "SELECT n FROM habits")).toEqual({
      isError: true,
      text: "query exceeded the time limit",
    })
  } finally {
    Date.now = realNow
  }
})

test("exactTotal refuses a count below the rows already read, and reports a failed count", async () => {
  const runQuery = { authorize: () => true, maxRows: 2, exactTotal: true }
  const low = serveDatabaseAsMcp(scripted({ count: () => 1 }), { tables: ["habits"], runQuery })
  expect(await call(low, "SELECT n FROM habits")).toEqual({
    isError: true,
    text: "query failed: invalid row count",
  })
  const failing = serveDatabaseAsMcp(
    scripted({
      count: () => {
        throw new Error("disk I/O error")
      },
    }),
    { tables: ["habits"], runQuery },
  )
  expect(await call(failing, "SELECT n FROM habits")).toEqual({
    isError: true,
    text: "query failed to count results: Error: disk I/O error",
  })
})
