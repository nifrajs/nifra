import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  dbRefusal,
  explainSqlite,
  fitToBytes,
  gateSqliteStatement,
  isDbRefusal,
  openReadOnlySqlite,
  querySqlite,
  REDACTED_CELL,
  readSqliteSchema,
  resolveSqliteFile,
  shapeRows,
  sqliteRelations,
  toJsonCell,
  unexposedPlanRelation,
} from "../src/engine.ts"
import { HOSTILE_CORPUS } from "./fixtures/hostile-corpus.ts"

const scratch = mkdtempSync(join(tmpdir(), "nifra-mcp-db-engine-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function seededFile(options: { wal?: boolean } = {}): string {
  const dir = join(scratch, `db-${counter++}`)
  mkdirSync(dir)
  const file = join(dir, "app.db")
  const db = new Database(file)
  if (options.wal === true) db.run("PRAGMA journal_mode = WAL")
  db.run(`CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open',
    total INTEGER, user_id INTEGER REFERENCES users (id), blob BLOB)`)
  db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT)")
  db.run("CREATE TABLE secrets (id INTEGER PRIMARY KEY, value TEXT)")
  db.run("CREATE VIEW secret_view AS SELECT * FROM secrets")
  db.run("CREATE VIEW paid AS SELECT * FROM orders WHERE status = 'paid'")
  db.run("CREATE INDEX orders_lower_status ON orders (lower(status))")
  db.run("CREATE VIEW virtual_rows AS SELECT * FROM json_each('[1, 2]')")
  db.run("INSERT INTO users (email, password_hash) VALUES ('a@example.com', 'hash')")
  db.run(
    "INSERT INTO orders (status, total, user_id, blob) VALUES ('paid', 9007199254740993, 1, x'0102'), ('open', 5, 1, NULL)",
  )
  db.run("INSERT INTO secrets (value) VALUES ('top secret')")
  if (options.wal === true) db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
  // No writer has it open now: a WAL database without its -wal and -shm files.
  rmSync(`${file}-wal`, { force: true })
  rmSync(`${file}-shm`, { force: true })
  return file
}

const CAPS = { maxRows: 50, maxResultBytes: 64 * 1024 }

describe("refusals", () => {
  test("every refusal carries a fix and a docs anchor", () => {
    const refusal = dbRefusal("NIFRA_DB_TABLE_EXCLUDED", "no")
    expect(refusal).toMatchObject({
      code: "NIFRA_DB_TABLE_EXCLUDED",
      docsAnchor: "agents#db-table-excluded",
    })
    expect(refusal.fix.length).toBeGreaterThan(20)
    expect(isDbRefusal(refusal)).toBe(true)
    expect(isDbRefusal({ code: "NIFRA_DB_NOPE", message: "x" })).toBe(false)
    expect(isDbRefusal({ code: "NIFRA_DB_DRIVER" })).toBe(false)
    expect(isDbRefusal(null)).toBe(false)
  })
})

describe("statement gates", () => {
  const exposed = (name: string) => name === "orders"
  test("empty, several, non-read and unexposed statements are refused", () => {
    expect(gateSqliteStatement("  ", exposed)).toMatchObject({ ok: false, reason: "empty" })
    expect(gateSqliteStatement("SELECT 1; SELECT 2", exposed)).toMatchObject({ reason: "multiple" })
    expect(gateSqliteStatement("DELETE FROM orders", exposed)).toMatchObject({ reason: "not-read" })
    expect(gateSqliteStatement("SELECT * FROM users", exposed)).toMatchObject({
      reason: "unexposed",
      relation: "users",
    })
    expect(gateSqliteStatement("SELECT * FROM orders;", exposed)).toEqual({
      ok: true,
      query: "SELECT * FROM orders",
    })
  })

  test("the plan check skips planner pseudo-nodes and reads the last dotted segment", () => {
    expect(unexposedPlanRelation([{ detail: "SCAN CONSTANT ROW" }], exposed)).toBeUndefined()
    expect(unexposedPlanRelation([{ detail: "SCAN SUBQUERY 1" }], exposed)).toBeUndefined()
    expect(unexposedPlanRelation([{ detail: "SCAN main.orders" }], exposed)).toBeUndefined()
    expect(unexposedPlanRelation([{ detail: "SEARCH users USING INDEX x" }], exposed)).toBe("users")
    expect(unexposedPlanRelation([{ detail: 7 }], exposed)).toBeUndefined()
  })
})

describe("caps and cells", () => {
  test("fitToBytes halves until the JSON fits, and gives up when nothing fits", () => {
    const rows = Array.from({ length: 64 }, (_, index) => ({ index, pad: "x".repeat(40) }))
    const fit = fitToBytes(rows.length, (shown) => rows.slice(0, shown), 1_000)
    expect(fit?.shown).toBe(16)
    expect(fit?.serialized.length).toBeLessThanOrEqual(1_000)
    expect(fitToBytes(1, () => ({ big: "x".repeat(100) }), 10)).toBeUndefined()
  })

  test("toJsonCell makes every database value JSON-safe", () => {
    const text = (value: string) => value.replace("secret", "[gone]")
    expect(toJsonCell(undefined)).toBeNull()
    expect(toJsonCell("a secret", { text })).toBe("a [gone]")
    expect(toJsonCell("plain")).toBe("plain")
    expect(toJsonCell(Number.NaN)).toBe("NaN")
    expect(toJsonCell(Number.POSITIVE_INFINITY)).toBe("Infinity")
    expect(toJsonCell(12n)).toBe(12)
    expect(toJsonCell(9007199254740993n)).toBe("9007199254740993")
    expect(toJsonCell(-9007199254740993n)).toBe("-9007199254740993")
    expect(toJsonCell(true)).toBe(true)
    expect(toJsonCell(Symbol.for("s"))).toBe("Symbol(s)")
    expect(toJsonCell(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z")
    expect(toJsonCell(new Date(Number.NaN))).toBeNull()
    expect(toJsonCell(new Uint8Array([1, 2, 3]))).toBe("<3 bytes>")
    expect(toJsonCell(new ArrayBuffer(4))).toBe("<4 bytes>")
    const nested = JSON.parse(
      '{"__proto__": {"x": 1}, "password": "p", "token": null, "list": [{"api_key": "k", "n": 1}]}',
    )
    const cell = toJsonCell(nested, { column: (name) => name === "password" || name === "api_key" })
    expect(JSON.stringify(cell)).toBe(
      '{"__proto__":{"x":1},"password":"[redacted]","token":null,"list":[{"api_key":"[redacted]","n":1}]}',
    )
    expect(Object.getPrototypeOf(cell)).toBeNull()
    let deep: unknown = "bottom"
    for (let level = 0; level < 40; level++) deep = [deep]
    expect(JSON.stringify(toJsonCell(deep))).toContain('"[nested]"')
  })

  test("shapeRows caps by rows and by bytes and masks whole columns", () => {
    const columns = ["id", "password_hash", "note"]
    const rows = Array.from({ length: 5 }, (_, id) => [id, id === 0 ? null : "h", "x".repeat(200)])
    const shaped = shapeRows(columns, rows, {
      maxRows: 3,
      maxResultBytes: 10_000,
      redaction: { column: (name) => name === "password_hash" },
    })
    expect(shaped).toMatchObject({
      rowCount: 3,
      truncated: true,
      redactedColumns: ["password_hash"],
    })
    expect(shaped.rows[0]).toEqual([0, null, "x".repeat(200)])
    expect(shaped.rows[1]?.[1]).toBe(REDACTED_CELL)
    const bytes = shapeRows(columns, rows.slice(0, 4), { maxRows: 10, maxResultBytes: 600 })
    expect(bytes).toMatchObject({ rowCount: 2, truncated: true })
    const nothing = shapeRows(columns, rows, { maxRows: 10, maxResultBytes: 10 })
    expect(nothing).toMatchObject({ rowCount: 0, rows: [], truncated: true })
    expect(shapeRows(columns, [], CAPS)).toMatchObject({ rowCount: 0, truncated: false })
  })
})

describe("resolveSqliteFile", () => {
  test("a file inside the root resolves; a symlink out of it is refused unless allowed", () => {
    const root = join(scratch, "root")
    const outside = join(scratch, "outside")
    mkdirSync(join(root, "data"), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(root, "data", "app.db"), "")
    writeFileSync(join(outside, "other.db"), "")
    symlinkSync(join(outside, "other.db"), join(root, "data", "link.db"))
    expect(resolveSqliteFile(root, "data/app.db")).toEndWith(join("root", "data", "app.db"))
    const refused = resolveSqliteFile(root, "data/link.db")
    expect(isDbRefusal(refused) ? refused.code : refused).toBe("NIFRA_DB_OUTSIDE_ROOT")
    const dotdot = resolveSqliteFile(root, "../outside/other.db")
    expect(isDbRefusal(dotdot) ? dotdot.code : dotdot).toBe("NIFRA_DB_OUTSIDE_ROOT")
    expect(
      resolveSqliteFile(root, "data/link.db", ["missing.db", "../outside/other.db"]),
    ).toEndWith(join("outside", "other.db"))
    const missing = resolveSqliteFile(root, "data/none.db")
    expect(isDbRefusal(missing) ? missing.code : missing).toBe("NIFRA_DB_DRIVER")
    symlinkSync(join(root, "loop-a"), join(root, "loop-b"))
    symlinkSync(join(root, "loop-b"), join(root, "loop-a"))
    const loop = resolveSqliteFile(root, "loop-a")
    expect(isDbRefusal(loop) ? loop.code : loop).toBe("NIFRA_DB_DRIVER")
  })
})

describe("openReadOnlySqlite", () => {
  test("a rollback-journal file opens read-only and the engine refuses writes", async () => {
    const db = await openReadOnlySqlite(seededFile())
    try {
      expect(() => db.run("DELETE FROM orders")).toThrow(/readonly/)
      expect(db.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 2n })
    } finally {
      db.close()
    }
  })

  test("a WAL file with no writer opens through the query_only fallback, still refusing writes", async () => {
    const file = seededFile({ wal: true })
    expect(existsSync(`${file}-wal`)).toBe(false)
    const db = await openReadOnlySqlite(file)
    try {
      expect(() => db.run("INSERT INTO orders (status) VALUES ('x')")).toThrow(/readonly/)
      expect(db.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 2n })
    } finally {
      db.close()
    }
  })

  test("a WAL file reads consistently while another process writes it", async () => {
    const file = seededFile({ wal: true })
    const writer = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Database } = require("bun:sqlite")
         const db = new Database(${JSON.stringify(file)})
         db.run("PRAGMA busy_timeout = 2000")
         console.log("ready")
         const until = Date.now() + 1500
         while (Date.now() < until) db.run("INSERT INTO orders (status) VALUES ('w')")
         db.close()`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const reader = writer.stdout.getReader()
    await reader.read()
    let last = 0
    let reads = 0
    while (writer.exitCode === null && reads < 25) {
      const db = await openReadOnlySqlite(file)
      try {
        const rows = querySqlite(db, "SELECT count(*) AS n FROM orders", CAPS)
        if (isDbRefusal(rows)) throw new Error(rows.message)
        const n = Number(rows.rows[0]?.[0])
        expect(n).toBeGreaterThanOrEqual(last)
        last = n
        reads++
      } finally {
        db.close()
      }
    }
    await writer.exited
    expect(writer.exitCode).toBe(0)
    expect(reads).toBeGreaterThan(3)
    expect(last).toBeGreaterThan(2)
  })

  test("a file that is not a database is reported, not opened", async () => {
    const file = join(scratch, "not-a-db.db")
    writeFileSync(file, "x".repeat(4096))
    await expect(openReadOnlySqlite(file)).rejects.toThrow()
  })
})

describe("query, explain, schema", () => {
  test("the hostile corpus is refused with the expected code", async () => {
    const db = await openReadOnlySqlite(seededFile())
    const outcomes: Record<string, string | undefined> = {}
    const expected: Record<string, string | undefined> = {}
    try {
      for (const entry of HOSTILE_CORPUS) {
        if (entry.sqlite === null) continue
        const result = querySqlite(db, entry.sql, { ...CAPS, exclude: ["secrets"] })
        outcomes[entry.name] = isDbRefusal(result) ? result.code : undefined
        expected[entry.name] = entry.sqlite
      }
      expect(outcomes).toEqual(expected)
      expect(db.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 2n })
    } finally {
      db.close()
    }
  })

  test("a query returns aliased reads, exact integers and masked values", async () => {
    const db = await openReadOnlySqlite(seededFile())
    try {
      const rows = querySqlite(
        db,
        "SELECT o.id, o.id, o.total, o.blob, u.password_hash FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id",
        { ...CAPS, redaction: { column: (name) => name === "password_hash" } },
      )
      // The bounding subselect makes SQLite suffix a repeated name.
      expect(rows).toEqual({
        columns: ["id", "id:1", "total", "blob", "password_hash"],
        rows: [
          [1, 1, "9007199254740993", "<2 bytes>", REDACTED_CELL],
          [2, 2, 5, null, REDACTED_CELL],
        ],
        rowCount: 2,
        truncated: false,
        redactedColumns: ["password_hash"],
      })
      expect(querySqlite(db, "SELECT * FROM orders", { ...CAPS, maxRows: 1 })).toMatchObject({
        rowCount: 1,
        truncated: true,
      })
      const missing = querySqlite(db, "SELECT * FROM nope", CAPS)
      expect(isDbRefusal(missing) && missing.message).toContain("not a table or view")
      const excluded = querySqlite(db, "SELECT * FROM secrets", { ...CAPS, exclude: ["SECRETS"] })
      expect(isDbRefusal(excluded) && excluded.message).toContain("devDatabase.exclude")
      const recursive = querySqlite(
        db,
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 3) SELECT * FROM c",
        CAPS,
      )
      expect(recursive).toMatchObject({ columns: ["x"], rows: [[1], [2], [3]] })
      const shadow = querySqlite(db, "WITH secrets(v) AS (SELECT 1) SELECT * FROM secrets", {
        ...CAPS,
        exclude: ["secrets"],
      })
      expect(shadow).toMatchObject({ rows: [[1]] })
      const virtual = querySqlite(db, "SELECT * FROM virtual_rows", CAPS)
      expect(isDbRefusal(virtual) && virtual.message).toContain("<virtual table>")
      const runtime = querySqlite(db, "SELECT json_extract('not json', '$')", CAPS)
      expect(isDbRefusal(runtime) ? runtime.code : runtime).toBe("NIFRA_DB_QUERY_FAILED")
    } finally {
      db.close()
    }
  })

  test("explain returns the plan steps, bounded by bytes", async () => {
    const db = await openReadOnlySqlite(seededFile())
    try {
      const plan = explainSqlite(db, "SELECT * FROM orders WHERE id = 1", CAPS)
      expect(plan).toMatchObject({ analyzed: false, truncated: false })
      expect(JSON.stringify(isDbRefusal(plan) ? plan : plan.plan)).toContain("SEARCH orders")
      const tight = explainSqlite(
        db,
        "SELECT * FROM orders o JOIN users u ON u.id = o.user_id JOIN orders p ON p.id = o.id",
        { maxResultBytes: 60 },
      )
      expect(tight).toMatchObject({ truncated: true })
      const refused = explainSqlite(db, "SELECT * FROM secret_view", {
        ...CAPS,
        exclude: ["secrets"],
      })
      expect(isDbRefusal(refused) ? refused.code : refused).toBe("NIFRA_DB_TABLE_EXCLUDED")
    } finally {
      db.close()
    }
  })

  test("schema describes exposed relations from the catalog", async () => {
    const db = await openReadOnlySqlite(seededFile())
    try {
      const schema = readSqliteSchema(db, {
        exclude: ["secrets"],
        redaction: {
          column: (name) => name === "password_hash",
          text: (value) => value.toUpperCase(),
        },
      })
      if (isDbRefusal(schema)) throw new Error(schema.message)
      expect(schema.excludedCount).toBe(1)
      expect(schema.tables.map((table) => `${table.kind}:${table.name}`)).toEqual([
        "table:orders",
        "view:paid",
        "view:secret_view",
        "table:users",
        "view:virtual_rows",
      ])
      const orders = schema.tables[0]
      expect(orders?.rowEstimate).toBe(2)
      expect(orders?.columns[1]).toEqual({
        name: "status",
        type: "TEXT",
        nullable: false,
        default: "'OPEN'",
        primaryKey: false,
        redacted: false,
      })
      expect(orders?.columns[0]).toMatchObject({ name: "id", primaryKey: true, nullable: false })
      expect(orders?.foreignKeys).toEqual([
        { columns: ["user_id"], references: { table: "users", columns: ["id"] } },
      ])
      expect(orders?.indexes).toEqual([
        { name: "orders_lower_status", unique: false, columns: ["<expression>"] },
      ])
      const users = schema.tables[3]
      expect(users?.columns.find((column) => column.name === "password_hash")?.redacted).toBe(true)
      expect(users?.indexes[0]).toMatchObject({ unique: true, columns: ["email"] })
      expect(schema.tables[1]?.rowEstimate).toBeNull()
      const one = readSqliteSchema(db, { table: "USERS" })
      expect(isDbRefusal(one) ? one.code : one.tables.map((table) => table.name)).toEqual(["users"])
      const refused = readSqliteSchema(db, { table: "secrets", exclude: ["secrets"] })
      expect(isDbRefusal(refused) ? refused.code : refused).toBe("NIFRA_DB_TABLE_EXCLUDED")
      expect(sqliteRelations(db, ["secrets"]).exposed.has("secrets")).toBe(false)
    } finally {
      db.close()
    }
  })

  test("engine errors map to stable codes", () => {
    const failing = (code: string | undefined, message = "boom") => ({
      prepare(sql: string) {
        if (sql.startsWith("SELECT name FROM sqlite_master"))
          return { all: () => [{ name: "orders" }] }
        const error = Object.assign(new Error(message), code === undefined ? {} : { code })
        throw error
      },
    })
    const codeFor = (code: string | undefined, message?: string) => {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the fake has only prepare().all(), all the engine calls on this path
      const result = querySqlite(failing(code, message) as never, "SELECT 1", CAPS)
      return isDbRefusal(result) ? result.code : undefined
    }
    expect(codeFor("SQLITE_READONLY")).toBe("NIFRA_DB_WRITE_REFUSED")
    expect(codeFor("SQLITE_READONLY_DBMOVED")).toBe("NIFRA_DB_WRITE_REFUSED")
    expect(codeFor("SQLITE_AUTH")).toBe("NIFRA_DB_WRITE_REFUSED")
    expect(codeFor("SQLITE_INTERRUPT")).toBe("NIFRA_DB_TIMEOUT")
    expect(codeFor("SQLITE_ERROR", 'near "DELETE": syntax error')).toBe("NIFRA_DB_WRITE_REFUSED")
    expect(codeFor("SQLITE_ERROR", 'near "FOR": syntax error')).toBe("NIFRA_DB_QUERY_FAILED")
    expect(codeFor("SQLITE_CANTOPEN")).toBe("NIFRA_DB_DRIVER")
    expect(codeFor("SQLITE_CORRUPT")).toBe("NIFRA_DB_DRIVER")
    expect(codeFor("SQLITE_IOERR_READ")).toBe("NIFRA_DB_DRIVER")
    expect(codeFor("SQLITE_NOTADB")).toBe("NIFRA_DB_DRIVER")
    expect(codeFor(undefined)).toBe("NIFRA_DB_QUERY_FAILED")
    const brokenCatalog = {
      prepare: () => ({
        all: () => {
          throw Object.assign(new Error("io"), { code: "SQLITE_IOERR" })
        },
      }),
    }
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the fake has only prepare().all(), all the engine calls on this path
    const schema = readSqliteSchema(brokenCatalog as never)
    expect(isDbRefusal(schema) ? schema.code : schema).toBe("NIFRA_DB_DRIVER")
    let calls = 0
    const brokenTable = {
      prepare: () => ({
        all: () => {
          if (calls++ === 0) return [{ name: "orders", type: "table" }]
          throw new Error("gone")
        },
      }),
    }
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the fake has only prepare().all(), all the engine calls on this path
    const partial = readSqliteSchema(brokenTable as never)
    expect(isDbRefusal(partial) ? partial.code : partial).toBe("NIFRA_DB_QUERY_FAILED")
    let planned = 0
    const brokenExplain = {
      prepare: (sql: string) => {
        if (sql.startsWith("SELECT name FROM sqlite_master")) return { all: () => [] }
        return {
          all: () => {
            if (planned++ === 0) return []
            throw Object.assign(new Error("interrupted"), { code: "SQLITE_INTERRUPT" })
          },
        }
      },
    }
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the fake has only prepare().all(), all the engine calls on this path
    const explained = explainSqlite(brokenExplain as never, "SELECT 1", CAPS)
    expect(isDbRefusal(explained) ? explained.code : explained).toBe("NIFRA_DB_TIMEOUT")
  })
})
