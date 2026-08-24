import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpDbConfigError, serveDatabaseAsMcp } from "../src/index.ts"

function seededDb(): Database {
  const db = new Database(":memory:")
  db.run("CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
  db.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, habit_id INTEGER, day TEXT)")
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)") // deliberately NOT exposed
  db.run("CREATE TABLE constant (id INTEGER PRIMARY KEY)") // deliberately NOT exposed
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

async function withFakeWorker<T>(
  closeMode: "throw" | "ignore",
  action: () => Promise<T>,
): Promise<T> {
  const previousWorker = globalThis.Worker
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null

    postMessage(message: { id?: number; type?: string }): void {
      if (message.type === "close") {
        if (closeMode === "throw") throw new Error("worker is unavailable")
        return
      }
      queueMicrotask(() =>
        this.onmessage?.({ data: { id: message.id, ok: true, rows: [] } } as MessageEvent),
      )
    }

    terminate(): void {}
    unref(): void {}
  }
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: FakeWorker,
  })
  try {
    return await action()
  } finally {
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: previousWorker,
    })
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

  test("query_only is set on the connection - writes are rejected engine-side", () => {
    const db = seededDb()
    serveDatabaseAsMcp(db, { tables: ["habits"] })
    expect(() => db.run("INSERT INTO habits (name) VALUES ('x')")).toThrow()
  })

  test("rejects invalid result limits at boot", () => {
    expect(() =>
      serveDatabaseAsMcp(seededDb(), {
        tables: ["habits"],
        runQuery: { authorize: () => true, maxRows: Number.NaN },
      }),
    ).toThrow(/maxRows/)
    expect(() =>
      serveDatabaseAsMcp(seededDb(), {
        tables: ["habits"],
        runQuery: { authorize: () => true, maxResultBytes: Number.POSITIVE_INFINITY },
      }),
    ).toThrow(/maxResultBytes/)
    expect(() =>
      serveDatabaseAsMcp(seededDb(), {
        tables: ["habits"],
        runQuery: { authorize: () => true, queryTimeoutMs: Number.NaN },
      }),
    ).toThrow(/queryTimeoutMs/)
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

  afterAll(async () => {
    await server.close?.()
    await server.close?.()
  })

  test("unauthorized request is rejected at the transport boundary", async () => {
    const result = await call(server, "run_query", { sql: "SELECT * FROM habits" })
    expect(result.isError).toBe(true)
    expect(result.text).toBe("unauthorized")
  })

  // The wire shape a client actually branches on: an HTTP status it can act on, and a code in
  // JSON-RPC's implementation-defined server-error band rather than one the spec reserves.
  test("the rejection is a 403 with a JSON-RPC error, carrying no rows", async () => {
    const response = await server.fetch(
      new Request("http://t/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "run_query", arguments: { sql: "SELECT * FROM habits" } },
        }),
      }),
    )
    expect(response.status).toBe(403)
    const body = (await response.json()) as {
      id?: unknown
      result?: unknown
      error?: { code?: number; message?: string }
    }
    expect(body.id).toBe(7)
    expect(body.result).toBeUndefined()
    expect(body.error?.code).toBe(-32001)
    expect(body.error?.message).toBe("unauthorized")
  })

  test("a non-run_query tool is unaffected by the authorize gate", async () => {
    const result = await call(server, "list_tables")
    expect(result.isError).toBe(false)
    expect(result.text).toContain("habits")
  })

  test("authorized SELECT returns rows, capped with a truncation marker", async () => {
    const { text, isError } = await call(server, "run_query", { sql: "SELECT * FROM habits" }, auth)
    expect(isError).toBe(false)
    const result = JSON.parse(text) as {
      rows: unknown[]
      truncated?: boolean
      total?: number | null
    }
    expect(result.rows).toHaveLength(1)
    expect(result.truncated).toBe(true)
    expect(result.total).toBeNull()
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
    const comment = await call(server, "run_query", { sql: "SELECT 1 -- trailing comment" }, auth)
    expect(comment.isError).toBe(false)
  })

  test("a SELECT that touches an unexposed table is rejected by plan verification", async () => {
    for (const sql of [
      "SELECT * FROM users",
      "SELECT * FROM constant",
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
      truncated?: boolean
      total?: number | null
    }
    expect(result.rows.length).toBeLessThanOrEqual(2)
    expect(result.truncated).toBe(true)
    expect(result.total).toBe(20)
    expect(text.length).toBeLessThanOrEqual(3000)
  })

  test("bounds database materialization before applying the row cap", async () => {
    let materialized = 0
    let countCalls = 0
    const fakeDb = {
      run() {},
      interrupt() {},
      prepare(sql: string) {
        return {
          all() {
            if (sql.startsWith("EXPLAIN QUERY PLAN")) return [{ detail: "SCAN TABLE habits" }]
            if (sql.includes("__nifra_total")) {
              countCalls += 1
              return [{ __nifra_total: 100_000 }]
            }
            const limit = Number(/LIMIT (\d+)$/.exec(sql)?.[1] ?? 100_000)
            materialized = Math.max(materialized, limit)
            return Array.from({ length: limit }, (_, id) => ({ id }))
          },
        }
      },
    }
    const bounded = serveDatabaseAsMcp(fakeDb, {
      tables: ["habits"],
      runQuery: { authorize: () => true, maxRows: 2 },
    })
    const result = await call(bounded, "run_query", { sql: "SELECT * FROM habits" })
    expect(result.isError).toBe(false)
    expect(materialized).toBe(3) // maxRows + one sentinel row, never the full 100k result
    expect(countCalls).toBe(0)
    expect(JSON.parse(result.text).truncated).toBe(true)
    expect(JSON.parse(result.text).total).toBeNull()
  })

  test("a recursive CTE is rejected by name, like any other unexposed relation", async () => {
    const result = await call(
      server,
      "run_query",
      {
        sql: "WITH RECURSIVE loop(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM loop) SELECT x FROM loop",
      },
      auth,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toBe('query touches "loop", which is not exposed')
  })

  // An alias renames the relation in EXPLAIN QUERY PLAN output (`users AS habits` plans as
  // `SCAN habits`), so the plan alone cannot tell an allowlisted table from an attacker's alias for
  // an unexposed one. The SQL itself has to be read - and read the way SQLite reads it: no separator
  // is required between a keyword and a quoted identifier, and four identifier quotings are legal.
  // Every case below returned the unexposed `users` table's rows against a whitespace-anchored,
  // double-quote-only matcher.
  const ALIAS_ESCAPES: ReadonlyArray<readonly [string, string]> = [
    ["no separator before a quoted name", 'SELECT * FROM"users"AS habits'],
    ["no separator and an implicit alias", 'SELECT * FROM"users"habits'],
    ["bracket quoting", "SELECT * FROM [users] AS habits"],
    ["backtick quoting", "SELECT * FROM `users` AS habits"],
    ["bracket quoting, no separator", "SELECT * FROM [users]habits"],
    ["backtick quoting, no separator", "SELECT * FROM`users`habits"],
    ["schema-qualified and bracket-quoted", "SELECT * FROM main.[users] AS habits"],
    ["comment as the separator", "SELECT * FROM/**/users AS habits"],
    ["plain alias", "SELECT * FROM users AS habits"],
    ["aliased subquery", "SELECT * FROM (SELECT * FROM [users]) AS habits"],
    [
      "a CTE over the unexposed table",
      "WITH x AS (SELECT * FROM [users]) SELECT * FROM x AS habits",
    ],
  ]
  for (const [label, sql] of ALIAS_ESCAPES) {
    test(`an unexposed table stays unexposed: ${label}`, async () => {
      const result = await call(server, "run_query", { sql }, auth)
      expect(result.isError).toBe(true)
      expect(result.text).toContain("is not exposed")
      expect(result.text).not.toContain("secret@example.com")
    })
  }

  // The mirror of the above: reading the SQL must not start rejecting queries that only ever touch
  // allowlisted tables, however they are spelled.
  const ALLOWED_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
    ["double-quoted", 'SELECT * FROM "habits"'],
    ["bracket-quoted", "SELECT * FROM [habits]"],
    ["backtick-quoted", "SELECT * FROM `habits`"],
    ["schema-qualified", "SELECT * FROM main.habits"],
    ["schema-qualified and quoted", 'SELECT * FROM main."habits"'],
    ["a CTE over an exposed table", "WITH x AS (SELECT * FROM habits) SELECT * FROM x"],
    ["a literal that merely looks like SQL", "SELECT * FROM habits WHERE name = 'FROM users'"],
  ]
  for (const [label, sql] of ALLOWED_SPELLINGS) {
    test(`an exposed table stays queryable: ${label}`, async () => {
      const result = await call(server, "run_query", { sql }, auth)
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.text).rows).toBeArray()
    })
  }
})

describe("query execution lanes", () => {
  const auth = { "x-key": "secret" }

  test("a database with no interrupt and no file still serves queries", async () => {
    // An embedder passing a structural shim must not be refused at construction.
    const shim = {
      prepare: (sql: string) => ({ all: () => (sql.startsWith("EXPLAIN") ? [] : [{ n: 1 }]) }),
      run: () => undefined,
    }
    const served = serveDatabaseAsMcp(shim, {
      tables: ["habits"],
      runQuery: { authorize: () => true },
    })
    const result = await call(served, "run_query", { sql: "SELECT 1 AS n" })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.text).rows).toEqual([{ n: 1 }])
  })

  test("an in-process overrun is reported once the statement returns", async () => {
    const shim = {
      prepare: (sql: string) => ({
        all: () => {
          if (sql.startsWith("EXPLAIN")) return []
          // A synchronous statement owns the thread; the deadline can only be seen after it ends.
          const buffer = new Int32Array(new SharedArrayBuffer(4))
          Atomics.wait(buffer, 0, 0, 30)
          return [{ n: 1 }]
        },
      }),
      run: () => undefined,
    }
    const served = serveDatabaseAsMcp(shim, {
      tables: ["habits"],
      runQuery: { authorize: () => true, queryTimeoutMs: 10 },
    })
    const result = await call(served, "run_query", { sql: "SELECT 1 AS n" })
    expect(result.isError).toBe(true)
    expect(result.text).toBe("query exceeded the time limit")
  })

  test("a file-backed database runs off a reusable worker, never a per-call snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nifra-mcp-db-"))
    const path = join(directory, "app.db")
    const db = new Database(path)
    db.run("CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    db.run("INSERT INTO habits (name) VALUES ('read'), ('run')")
    // Snapshotting copies the WHOLE database per call; the lane must never reach for it.
    let snapshots = 0
    Object.defineProperty(db, "serialize", {
      configurable: true,
      value: () => {
        snapshots += 1
        return new Uint8Array()
      },
    })
    const served = serveDatabaseAsMcp(db, {
      tables: ["habits"],
      runQuery: { authorize: (ctx) => ctx.request.headers.get("x-key") === "secret" },
    })
    try {
      const first = await call(served, "run_query", { sql: "SELECT name FROM habits" }, auth)
      const second = await call(
        served,
        "run_query",
        { sql: "SELECT count(*) AS n FROM habits" },
        auth,
      )
      expect(first.isError).toBe(false)
      expect(JSON.parse(first.text).rows).toEqual([{ name: "read" }, { name: "run" }])
      expect(second.isError).toBe(false)
      expect(JSON.parse(second.text).rows).toEqual([{ n: 2 }])
      expect(snapshots).toBe(0)
    } finally {
      await served.close?.()
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("a worker query that outlives its deadline is discarded, not awaited", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nifra-mcp-db-"))
    const path = join(directory, "slow.db")
    const db = new Database(path)
    db.run("CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    // A 1ms budget the worker cannot meet: spawning the thread, importing bun:sqlite and opening the
    // file already exceeds it, so the deadline timer fires first and the lane drops the connection it
    // can no longer bound rather than waiting on native SQLite. Exercises the worker abandon path.
    const served = serveDatabaseAsMcp(db, {
      tables: ["habits"],
      runQuery: { authorize: () => true, queryTimeoutMs: 1 },
    })
    try {
      const result = await call(served, "run_query", { sql: "SELECT name FROM habits" })
      expect(result.isError).toBe(true)
      expect(result.text).toBe("query exceeded the time limit")
    } finally {
      await served.close?.()
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("a failed worker close rejects pending work and releases the lane", async () => {
    await withFakeWorker("throw", async () => {
      const directory = mkdtempSync(join(tmpdir(), "nifra-mcp-db-"))
      const path = join(directory, "close-throws.db")
      const db = new Database(path)
      db.run("CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
      const served = serveDatabaseAsMcp(db, {
        tables: ["habits"],
        runQuery: { authorize: () => true },
      })
      try {
        const result = await call(served, "run_query", { sql: "SELECT name FROM habits" })
        expect(result.isError).toBe(false)
        await served.close?.()
        await served.close?.()
      } finally {
        db.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  })

  test("a worker that does not acknowledge close is force-terminated", async () => {
    await withFakeWorker("ignore", async () => {
      const directory = mkdtempSync(join(tmpdir(), "nifra-mcp-db-"))
      const path = join(directory, "close-timeout.db")
      const db = new Database(path)
      db.run("CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
      const served = serveDatabaseAsMcp(db, {
        tables: ["habits"],
        runQuery: { authorize: () => true },
      })
      try {
        const result = await call(served, "run_query", { sql: "SELECT name FROM habits" })
        expect(result.isError).toBe(false)
        await served.close?.()
      } finally {
        db.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  })
})
