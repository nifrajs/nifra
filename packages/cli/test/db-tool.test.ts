import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDbRefusal } from "@nifrajs/mcp-db/engine"
import { parsePostgresUrl } from "@nifrajs/mcp-db/postgres"
import { SQL } from "bun"
import { bindCommandArgv, commandCatalog, commandMcpName } from "../src/command-catalog.ts"
import {
  appendDbAudit,
  DB_AUDIT_FILE,
  DB_AUDIT_MAX_BYTES,
  DB_AUDIT_ROTATED_FILE,
  type DbAuditEntry,
  readDbAudit,
  sqlFingerprint,
} from "../src/db-audit.ts"
import { dbRedaction, parseDbChildRequest, runDbOperation, serveDbChild } from "../src/db-child.ts"
import {
  type DevDatabase,
  loadDevDatabase,
  parseDevDatabase,
  readProjectEnv,
} from "../src/db-config.ts"
import {
  DB_ROWS_NOTE,
  type DbToolOutput,
  dbAuditSpec,
  dbQuerySpec,
  dbRoleSpec,
  dbSchemaSpec,
  renderDbOutput,
  runDbChild,
} from "../src/db-tool.ts"
import { createFixtureProject, createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

const parent = createFixtureRoot("db-tool-")
afterAll(() => removeFixtureRoot(parent))

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ"

/** A project with `data/app.db` and a `nifra.config.ts` declaring it (`extra` lands in the object). */
function sqliteProject(extra = "", configHead = ""): string {
  const root = createFixtureProject(parent, "app-")
  mkdirSync(join(root, "data"))
  const db = new Database(join(root, "data", "app.db"))
  db.run(
    "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password_hash TEXT, api_token TEXT, bio TEXT)",
  )
  db.run("CREATE TABLE sessions (id INTEGER PRIMARY KEY, token TEXT)")
  db.run(
    "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id), total INTEGER)",
  )
  db.run(
    `INSERT INTO users (email, password_hash, api_token, bio) VALUES ('a@example.com', 'hash', 'tok-1', 'jwt ${JWT}')`,
  )
  db.run("INSERT INTO orders (user_id, total) VALUES (1, 10), (1, 20)")
  db.run("INSERT INTO sessions (token) VALUES ('s')")
  db.close()
  writeFileSync(
    join(root, "nifra.config.ts"),
    `${configHead}\nexport const devDatabase = { kind: "sqlite", file: "./data/app.db", exclude: ["sessions"], redactColumns: ["api_token"]${extra} }\n`,
  )
  return root
}

const ctx = (cwd: string, signal?: AbortSignal) => ({
  cwd,
  ...(signal === undefined ? {} : { signal }),
})

describe("devDatabase declaration", () => {
  test("defaults, and every field validated", () => {
    expect(parseDevDatabase({ kind: "sqlite", file: "app.db" })).toEqual({
      kind: "sqlite",
      file: "app.db",
      allowFiles: [],
      exclude: [],
      maxRows: 100,
      maxResultBytes: 102400,
      timeoutMs: 5000,
      redactColumns: [],
      revealColumns: [],
      query: true,
    })
    expect(
      parseDevDatabase({ kind: "postgres", url: "postgres://localhost/app", query: false }),
    ).toMatchObject({
      kind: "postgres",
      schemas: ["public"],
      allowHosts: [],
      allowExtensions: [],
      query: false,
    })
    const refused = (value: unknown) => {
      const result = parseDevDatabase(value)
      return isDbRefusal(result) ? `${result.code} ${result.message}` : "accepted"
    }
    expect(refused(null)).toContain("must be an object")
    expect(refused([])).toContain("must be an object")
    expect(refused({ kind: "mysql" })).toContain('"sqlite" or "postgres"')
    expect(refused({ kind: "sqlite", file: "a.db", exlude: ["x"] })).toBe(
      'NIFRA_DB_CONFIG devDatabase has no field "exlude" for kind sqlite',
    )
    expect(refused({ kind: "sqlite", file: "a.db", url: "x" })).toContain('"url"')
    expect(refused({ kind: "sqlite", file: "a.db", query: "yes" })).toContain(
      "query must be a boolean",
    )
    expect(refused({ kind: "sqlite", file: "a.db", maxRows: 0 })).toContain(
      "maxRows must be an integer from 1",
    )
    expect(refused({ kind: "sqlite", file: "a.db", maxResultBytes: 2 * 1024 * 1024 })).toContain(
      "524288",
    )
    expect(refused({ kind: "sqlite", file: "a.db", timeoutMs: 1.5 })).toContain("timeoutMs")
    expect(refused({ kind: "sqlite", file: "a.db", exclude: "users" })).toContain(
      "array of non-empty strings",
    )
    expect(refused({ kind: "sqlite", file: "a.db", exclude: [""] })).toContain(
      "array of non-empty strings",
    )
    expect(refused({ kind: "sqlite", file: ":memory:" })).toContain("SQLite database file")
    expect(refused({ kind: "sqlite" })).toContain("SQLite database file")
    expect(refused({ kind: "postgres" })).toContain("environment variable it reads is not set")
    expect(refused({ kind: "postgres", url: "" })).toContain("postgres:// URL")
  })

  test("loading applies the .env files without overriding the process env, then imports the config", async () => {
    const root = createFixtureProject(parent, "env-")
    const key = `NIFRA_DB_TEST_URL_${process.pid}`
    const kept = `NIFRA_DB_TEST_KEPT_${process.pid}`
    process.env[kept] = "from-process"
    writeFileSync(join(root, ".env"), `${key}=postgres://localhost/base\n${kept}=from-file\n`)
    writeFileSync(join(root, ".env.local"), `${key}=postgres://localhost/local\n`)
    writeFileSync(
      join(root, "nifra.config.ts"),
      `export const devDatabase = { kind: "postgres", url: process.env.${key}, schemas: [process.env.${kept}] }\n`,
    )
    try {
      expect(await readProjectEnv(root)).toEqual({
        [key]: "postgres://localhost/local",
        [kept]: "from-file",
      })
      expect(await loadDevDatabase(root)).toMatchObject({
        url: "postgres://localhost/local",
        schemas: ["from-process"],
      })
    } finally {
      delete process.env[key]
      delete process.env[kept]
    }
    const empty = createFixtureProject(parent, "none-")
    expect(await loadDevDatabase(empty)).toMatchObject({ code: "NIFRA_DB_NOT_DECLARED" })
    writeFileSync(join(empty, "nifra.config.ts"), "export const other = 1\n")
    expect(await loadDevDatabase(empty)).toMatchObject({ code: "NIFRA_DB_NOT_DECLARED" })
    const broken = createFixtureProject(parent, "broken-")
    writeFileSync(join(broken, "nifra.config.ts"), 'throw new Error("config exploded")\n')
    const loaded = await loadDevDatabase(broken)
    expect(loaded).toMatchObject({ code: "NIFRA_DB_CONFIG" })
    expect(isDbRefusal(loaded) && loaded.message).toContain("config exploded")
  })
})

describe("one operation, in process", () => {
  const declared = (patch: Partial<DevDatabase> = {}): DevDatabase => {
    const db = parseDevDatabase({
      kind: "sqlite",
      file: "./data/app.db",
      exclude: ["sessions"],
      redactColumns: ["api_token"],
    })
    if (isDbRefusal(db)) throw new Error(db.message)
    return { ...db, ...patch } as DevDatabase
  }

  test("schema, query, explain and role on SQLite", async () => {
    const root = sqliteProject()
    const db = declared()
    const schema = await runDbOperation(root, { op: "schema" }, db)
    expect(schema).toMatchObject({ ok: true, engine: "sqlite", database: "./data/app.db" })
    expect(schema.ok && schema.schema?.tables.map((table) => table.name)).toEqual([
      "orders",
      "users",
    ])
    const query = await runDbOperation(root, { op: "query", sql: "SELECT * FROM users" }, db)
    if (!query.ok) throw new Error(query.refusal.message)
    expect(query.rows?.columns).toEqual(["id", "email", "password_hash", "api_token", "bio"])
    expect(query.rows?.rows[0]).toEqual([
      1,
      "a@example.com",
      "[redacted]",
      "[redacted]",
      "jwt [redacted:JWT]",
    ])
    expect(query.rows?.redactedColumns).toEqual(["password_hash", "api_token"])
    const explain = await runDbOperation(root, { op: "explain", sql: "SELECT * FROM orders" }, db)
    expect(explain.ok && JSON.stringify(explain.plan?.plan)).toContain("SCAN orders")
    expect(await runDbOperation(root, { op: "role" }, db)).toMatchObject({
      ok: true,
      role: { statements: [] },
    })
    const revealed = await runDbOperation(
      root,
      { op: "query", sql: "SELECT password_hash FROM users" },
      {
        ...db,
        revealColumns: ["PASSWORD_HASH"],
      },
    )
    expect(revealed.ok && revealed.rows?.rows).toEqual([["hash"]])
  })

  test("refusals: excluded table, query off, outside the root, a closed Postgres port, a remote host", async () => {
    const root = sqliteProject()
    const db = declared()
    expect(
      await runDbOperation(root, { op: "query", sql: "SELECT * FROM sessions" }, db),
    ).toMatchObject({
      ok: false,
      refusal: { code: "NIFRA_DB_TABLE_EXCLUDED" },
    })
    expect(
      await runDbOperation(root, { op: "query", sql: "SELECT 1" }, { ...db, query: false }),
    ).toMatchObject({
      refusal: { code: "NIFRA_DB_QUERY_OFF" },
    })
    expect((await runDbOperation(root, { op: "schema" }, { ...db, query: false })).ok).toBe(true)
    const outside = join(mkdtempSync(join(tmpdir(), "nifra-db-outside-")), "other.db")
    new Database(outside).close()
    symlinkSync(outside, join(root, "data", "link.db"))
    expect(
      await runDbOperation(root, { op: "schema" }, {
        ...db,
        file: "./data/link.db",
      } as DevDatabase),
    ).toMatchObject({
      refusal: { code: "NIFRA_DB_OUTSIDE_ROOT" },
    })
    writeFileSync(join(root, "data", "junk.db"), "not a database at all, just text".repeat(200))
    expect(
      await runDbOperation(root, { op: "schema" }, {
        ...db,
        file: "./data/junk.db",
      } as DevDatabase),
    ).toMatchObject({
      refusal: { code: "NIFRA_DB_DRIVER" },
    })
    const pg = (url: string, patch: Record<string, unknown> = {}) => {
      const parsed = parseDevDatabase({ kind: "postgres", url, timeoutMs: 500, ...patch })
      if (isDbRefusal(parsed)) throw new Error(parsed.message)
      return parsed
    }
    expect(
      await runDbOperation(
        root,
        { op: "query", sql: "SELECT 1" },
        pg("postgres://u:p@db.example.com/app"),
      ),
    ).toMatchObject({
      refusal: { code: "NIFRA_DB_REMOTE_HOST" },
    })
    const closed = await runDbOperation(
      root,
      { op: "schema" },
      pg("postgres://u:p@127.0.0.1:1/app"),
    )
    expect(closed).toMatchObject({ ok: false, refusal: { code: "NIFRA_DB_DRIVER" } })
    expect(
      await runDbOperation(
        root,
        { op: "explain", sql: "SELECT 1" },
        pg("postgres://u@127.0.0.1:1/app", { query: false }),
      ),
    ).toMatchObject({
      refusal: { code: "NIFRA_DB_QUERY_OFF" },
    })
    expect(await runDbOperation(root, { op: "role" }, pg("mysql://x"))).toMatchObject({
      refusal: { code: "NIFRA_DB_CONFIG" },
    })
  })

  test("redaction masks credential columns and scrubs env values and token formats", () => {
    const db = declared({
      redactColumns: ["notes"],
      revealColumns: ["password"],
    } as Partial<DevDatabase>)
    const redaction = dbRedaction(parent, db, { MY_SECRET: "s3cr3t-value-0123456789" })
    expect(redaction.column?.("password_hash")).toBe(true)
    expect(redaction.column?.("Notes")).toBe(true)
    expect(redaction.column?.("password")).toBe(false)
    expect(redaction.column?.("email")).toBe(false)
    expect(redaction.text?.(`x s3cr3t-value-0123456789 ${JWT}`)).not.toContain("s3cr3t-value")
    expect(redaction.text?.(JWT)).not.toContain(JWT)
  })

  test("the child request is validated across the process boundary", () => {
    const token = "0123456789abcdef0123"
    expect(
      parseDbChildRequest(JSON.stringify({ token, op: "query", sql: "SELECT 1" })),
    ).toMatchObject({ op: "query" })
    for (const bad of [
      "not json",
      "null",
      JSON.stringify({ token: "short", op: "query" }),
      JSON.stringify({ token, op: "drop" }),
      JSON.stringify({ token, op: "query", sql: 1 }),
      JSON.stringify({ token, op: "schema", table: false }),
      JSON.stringify({ token, op: "explain", analyze: "yes" }),
    ]) {
      expect({ bad, parsed: parseDbChildRequest(bad) }).toEqual({ bad, parsed: undefined })
    }
  })
})

describe("the subprocess protocol", () => {
  const stream = (text: string) => new Response(text).body as ReadableStream<Uint8Array>
  const serve = async (root: string, request: unknown) => {
    const lines: string[] = []
    const served = await serveDbChild(root, stream(JSON.stringify(request)), async (line) => {
      lines.push(line)
    })
    return { served, lines }
  }
  const token = "abcdef0123456789abcd"

  test("ready, then the answer, each line behind the request's token", async () => {
    const root = sqliteProject()
    const { served, lines } = await serve(root, {
      token,
      op: "query",
      sql: "SELECT count(*) FROM orders",
    })
    expect(served).toBe(true)
    expect(lines.map((line) => line.slice(0, token.length + 1))).toEqual([`${token} `, `${token} `])
    expect(JSON.parse(lines[0]?.slice(token.length + 1) ?? "")).toEqual({
      type: "ready",
      timeoutMs: 5000,
    })
    expect(JSON.parse(lines[1]?.slice(token.length + 1) ?? "")).toMatchObject({
      type: "answer",
      answer: { ok: true, rows: { rows: [[2]] } },
    })
  })

  test("a refused declaration answers without ready; a broken env file is a driver refusal", async () => {
    const empty = createFixtureProject(parent, "child-empty-")
    const undeclared = await serve(empty, { token, op: "schema" })
    expect(undeclared.lines).toHaveLength(1)
    expect(undeclared.lines[0]).toContain("NIFRA_DB_NOT_DECLARED")
    const broken = sqliteProject()
    mkdirSync(join(broken, ".env"))
    const driver = await serve(broken, { token, op: "schema" })
    expect(driver.lines.at(-1)).toContain("NIFRA_DB_DRIVER")
    expect(await serve(empty, { op: "schema" })).toEqual({ served: false, lines: [] })
  })
})

describe("the audit log", () => {
  const entry = (patch: Partial<DbAuditEntry> = {}): DbAuditEntry => ({
    at: "2026-10-03T00:00:00.000Z",
    tool: "query",
    ok: true,
    durationMs: 3,
    ...patch,
  })

  test("fingerprints group a statement's shape", () => {
    const a = sqlFingerprint("SELECT * FROM users WHERE id = 1 AND email = 'a@x'")
    expect(sqlFingerprint("select *  from users\nwhere id = 99 and email = 'b''c' -- note")).toBe(a)
    expect(sqlFingerprint("SELECT /* x */ * FROM users WHERE id = 2.5 AND email = ''")).toBe(a)
    expect(sqlFingerprint("SELECT * FROM orders")).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test("owner-only, bounded by rotation, never through a symlink", () => {
    const root = createFixtureProject(parent, "audit-")
    expect(appendDbAudit(root, entry({ sql: "SELECT 1" }))).toBe(true)
    expect(statSync(join(root, ".nifra")).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, DB_AUDIT_FILE)).mode & 0o777).toBe(0o600)
    writeFileSync(join(root, DB_AUDIT_FILE), `${"x".repeat(DB_AUDIT_MAX_BYTES - 10)}\n`)
    expect(appendDbAudit(root, entry({ sql: "SELECT 2" }))).toBe(true)
    expect(existsSync(join(root, DB_AUDIT_ROTATED_FILE))).toBe(true)
    writeFileSync(
      join(root, DB_AUDIT_FILE),
      `${readFileSync(join(root, DB_AUDIT_FILE), "utf8")}{"torn":`,
    )
    appendDbAudit(root, entry({ sql: "SELECT 3", ok: false, code: "NIFRA_DB_TIMEOUT" }))
    expect(readDbAudit(root, 10).map((line) => line.sql)).toEqual(["SELECT 2"])
    const linked = createFixtureProject(parent, "audit-link-")
    const elsewhere = mkdtempSync(join(tmpdir(), "nifra-db-audit-target-"))
    symlinkSync(elsewhere, join(linked, ".nifra"))
    expect(appendDbAudit(linked, entry())).toBe(false)
    expect(existsSync(join(elsewhere, "db-audit.jsonl"))).toBe(false)
    const fileLink = createFixtureProject(parent, "audit-file-link-")
    mkdirSync(join(fileLink, ".nifra"))
    symlinkSync(join(elsewhere, "target.jsonl"), join(fileLink, DB_AUDIT_FILE))
    expect(appendDbAudit(fileLink, entry())).toBe(false)
    expect(readDbAudit(fileLink, 10)).toEqual([])
    expect(readDbAudit(createFixtureProject(parent, "audit-none-"), 5)).toEqual([])
    const blocked = createFixtureProject(parent, "audit-blocked-")
    writeFileSync(join(blocked, ".nifra"), "a file, not a directory")
    expect(appendDbAudit(blocked, entry())).toBe(false)
  })
})

describe("a fresh subprocess per call", () => {
  test("answers schema and query, marks rows untrusted and audits without rows", async () => {
    const root = sqliteProject()
    const schema = await dbSchemaSpec.run({}, ctx(root))
    expect(schema).toMatchObject({ ok: true, tool: "schema", engine: "sqlite", untrusted: true })
    expect(schema.tables?.map((table) => table.name)).toEqual(["orders", "users"])
    const one = await dbSchemaSpec.run({ table: "orders" }, ctx(root))
    expect(one.tables?.[0]?.foreignKeys).toEqual([
      { columns: ["user_id"], references: { table: "users", columns: ["id"] } },
    ])
    const rows = await dbQuerySpec.run(
      { sql: `SELECT id, bio, api_token FROM users WHERE bio <> '${JWT}'` },
      ctx(root),
    )
    expect(rows).toMatchObject({
      ok: true,
      tool: "query",
      columns: ["id", "bio", "api_token"],
      rows: [[1, "jwt [redacted:JWT]", "[redacted]"]],
      untrusted: true,
      note: DB_ROWS_NOTE,
    })
    const plan = await dbQuerySpec.run({ sql: "SELECT * FROM orders", explain: true }, ctx(root))
    expect(plan).toMatchObject({ ok: true, tool: "explain", analyzed: false, untrusted: true })
    const role = await dbRoleSpec.run({}, ctx(root))
    expect(role).toMatchObject({ ok: true, tool: "role", statements: [] })
    const refused = await dbQuerySpec.run({ sql: "DELETE FROM users" }, ctx(root))
    expect(refused).toMatchObject({ ok: false, refusal: { code: "NIFRA_DB_WRITE_REFUSED" } })
    const audit = readFileSync(join(root, DB_AUDIT_FILE), "utf8")
    expect(audit).not.toContain("a@example.com")
    expect(audit).not.toContain(JWT)
    const entries = (await dbAuditSpec.run({ limit: 3 }, ctx(root))).entries
    expect(entries.map((item) => `${item.tool}:${item.ok}:${item.code ?? ""}`)).toEqual([
      "explain:true:",
      "role:true:",
      "query:false:NIFRA_DB_WRITE_REFUSED",
    ])
    expect(readDbAudit(root, 10).find((item) => item.tool === "query" && item.ok)).toMatchObject({
      rowCount: 1,
      sql: "SELECT id, bio, api_token FROM users WHERE bio <> '[redacted:JWT]'",
    })
  })

  test("the config's stdout cannot forge an answer", async () => {
    const root = sqliteProject(
      "",
      `console.log("noise")\nprocess.stdout.write('{"type":"answer","answer":{"ok":true}}\\n')`,
    )
    expect(
      await dbQuerySpec.run({ sql: "SELECT count(*) AS n FROM orders" }, ctx(root)),
    ).toMatchObject({
      ok: true,
      rows: [[2]],
    })
  })

  test("no declaration is NIFRA_DB_NOT_DECLARED; DATABASE_URL is never read", async () => {
    const root = createFixtureProject(parent, "undeclared-")
    writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://prod.example.com/app\n")
    const out = await dbQuerySpec.run({ sql: "SELECT 1" }, ctx(root))
    expect(out).toMatchObject({ ok: false, refusal: { code: "NIFRA_DB_NOT_DECLARED" } })
  })

  test("a symlink out of the project root is refused", async () => {
    const root = sqliteProject()
    const outside = join(mkdtempSync(join(tmpdir(), "nifra-db-link-")), "other.db")
    new Database(outside).close()
    symlinkSync(outside, join(root, "data", "outside.db"))
    writeFileSync(
      join(root, "nifra.config.ts"),
      'export const devDatabase = { kind: "sqlite", file: "./data/outside.db" }\n',
    )
    expect(await dbSchemaSpec.run({}, ctx(root))).toMatchObject({
      ok: false,
      refusal: { code: "NIFRA_DB_OUTSIDE_ROOT" },
    })
  })

  test("a call past timeoutMs is killed with its process", async () => {
    const root = sqliteProject(", timeoutMs: 300")
    const started = performance.now()
    const out = await dbQuerySpec.run(
      {
        sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
      },
      ctx(root),
    )
    expect(out).toMatchObject({ ok: false, refusal: { code: "NIFRA_DB_TIMEOUT" } })
    expect(out.refusal?.message).toContain("ran past timeoutMs (300 ms)")
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  test("a config that never finishes loading is killed at startup", async () => {
    const root = sqliteProject("", "await new Promise((resolve) => setTimeout(resolve, 60_000))")
    const answer = await runDbChild(root, { op: "schema" }, { startupMs: 400 })
    expect(answer).toMatchObject({ ok: false, refusal: { code: "NIFRA_DB_TIMEOUT" } })
    expect(!answer.ok && answer.refusal.message).toContain("did not load within 0.4s")
  })

  test("a crashing subprocess is a structured NIFRA_DB_DRIVER refusal", async () => {
    const exits = sqliteProject("", 'console.error("about to exit"); process.exit(3)')
    const exited = await runDbChild(exits, { op: "schema" })
    expect(exited).toMatchObject({ ok: false, refusal: { code: "NIFRA_DB_DRIVER" } })
    expect(!exited.ok && exited.refusal.message).toBe(
      "the database process exited with code 3 before answering: about to exit",
    )
    const killed = sqliteProject("", 'process.kill(process.pid, "SIGKILL")')
    const signalled = await runDbChild(killed, { op: "schema" })
    expect(!signalled.ok && signalled.refusal.message).toContain("exited on SIGKILL")
  })

  test("cancelling the call kills the subprocess", async () => {
    const root = sqliteProject(", timeoutMs: 60000")
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const out = await dbQuerySpec.run(
      {
        sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
      },
      ctx(root, controller.signal),
    )
    expect(out).toMatchObject({
      ok: false,
      refusal: { code: "NIFRA_DB_DRIVER", message: "the call was cancelled" },
    })
    const early = await runDbChild(root, { op: "schema" }, { signal: AbortSignal.abort() })
    expect(!early.ok && early.refusal.message).toBe("the call was cancelled before it started")
  })
})

describe("the command surface", () => {
  test("one catalog spec per tool; schema, query and role reach MCP, audit stays CLI-only", () => {
    const byName = new Map(commandCatalog.map((entry) => [entry.name, entry]))
    for (const name of ["db-schema", "db-query", "db-role"]) {
      expect(byName.get(name)?.transports).toEqual(["cli", "mcp"])
    }
    expect(byName.get("db-audit")?.transports).toEqual(["cli"])
    expect(commandMcpName("db-query")).toBe("nifra_db_query")
  })

  test("argv binds positionals and flags; analyze implies explain", () => {
    expect(
      bindCommandArgv(dbQuerySpec, ["SELECT 1", "--analyze", "--dir", "apps/web", "--json"]),
    ).toEqual({ sql: "SELECT 1", explain: true, analyze: true, dir: "apps/web", json: true })
    expect(bindCommandArgv(dbSchemaSpec, ["orders"])).toMatchObject({ table: "orders" })
    expect(bindCommandArgv(dbAuditSpec, ["--limit", "9000"])).toMatchObject({ limit: 500 })
    expect(() => dbQuerySpec.input.parse({ sql: "  " })).toThrow("non-empty")
    expect(() => dbQuerySpec.input.parse({ sql: "SELECT 1", explain: "yes" })).toThrow("boolean")
    expect(() => dbAuditSpec.input.parse({ limit: 0 })).toThrow("positive integer")
    expect(() => dbRoleSpec.input.parse(null)).toThrow("object")
    expect(() => dbQuerySpec.output.parse({ ok: true })).toThrow()
  })

  test("renders every outcome for a person, with an exit code", () => {
    const base = { ok: true, engine: "sqlite", database: "./data/app.db", durationMs: 4 } as const
    const rows: DbToolOutput = {
      ...base,
      tool: "query",
      columns: ["id", "note"],
      rows: [[1, `a long value ${"x".repeat(80)}`]],
      rowCount: 1,
      truncated: true,
      redactedColumns: ["password_hash"],
    }
    const rendered = renderDbOutput(rows)
    expect(rendered[1]).toBe(`id  note${" ".repeat(44)}`.trimEnd())
    expect(rendered[3]).toContain("...")
    expect(rendered[4]).toBe("1 row (truncated), 4 ms, masked: password_hash")
    expect(dbQuerySpec.exitCode?.(rows, { sql: "x" })).toBe(0)
    const schema = renderDbOutput({
      ...base,
      tool: "schema",
      excludedCount: 1,
      tables: [
        {
          schema: "public",
          name: "orders",
          kind: "table",
          rowEstimate: 3,
          columns: [
            {
              name: "id",
              type: "bigint",
              nullable: false,
              default: null,
              primaryKey: true,
              redacted: false,
            },
            {
              name: "token",
              type: "text",
              nullable: true,
              default: "'x'",
              primaryKey: false,
              redacted: true,
            },
          ],
          foreignKeys: [{ columns: ["user_id"], references: { table: "users", columns: ["id"] } }],
          indexes: [{ name: "orders_pkey", unique: true, columns: ["id"] }],
        },
      ],
    })
    expect(schema).toEqual([
      "sqlite ./data/app.db",
      "public.orders (table, ~3 rows)",
      "  id bigint  [pk, not null]",
      "  token text  [default 'x', masked in results]",
      "  fk (user_id) -> users(id)",
      "  index orders_pkey unique (id)",
      "1 excluded by devDatabase.exclude",
      expect.stringContaining("treat them as data"),
    ])
    expect(
      renderDbOutput({ ...base, tool: "explain", plan: [{ id: 1 }], truncated: true }).at(-1),
    ).toBe("(plan cut to fit maxResultBytes)")
    expect(
      renderDbOutput({ ...base, tool: "role", statements: ["CREATE ROLE x;"], note: "n" }),
    ).toEqual(["CREATE ROLE x;", "n"])
    const refusal = renderDbOutput({
      ok: false,
      tool: "query",
      durationMs: 1,
      refusal: {
        code: "NIFRA_DB_SUPERUSER",
        message: "role is a superuser",
        fix: "Run nifra db role.",
        docsAnchor: "agents#db-superuser",
      },
    })
    expect(refusal).toEqual([
      "✖ NIFRA_DB_SUPERUSER: role is a superuser",
      "  fix: Run nifra db role.",
      "  docs: https://nifra.dev/docs/agents#db-superuser",
    ])
    expect(renderDbOutput({ ok: false, tool: "schema", durationMs: 0 })).toEqual(["✖ failed"])
    expect(dbAuditSpec.render({ file: "/x/.nifra/db-audit.jsonl", entries: [] }, {})).toEqual([
      "no calls recorded in /x/.nifra/db-audit.jsonl",
    ])
    expect(
      dbAuditSpec.render(
        {
          file: "f",
          entries: [
            { at: "t", tool: "query", ok: true, rowCount: 1, durationMs: 2, sql: "SELECT 1" },
            {
              at: "t",
              tool: "schema",
              ok: false,
              code: "NIFRA_DB_DRIVER",
              durationMs: 2,
              table: "orders",
            },
          ],
        },
        {},
      ),
    ).toEqual([
      "t  query    ok  1 row  2 ms  SELECT 1",
      "t  schema   NIFRA_DB_DRIVER  2 ms  orders",
      "f",
    ])
  })

  test("nifra db <sub> runs the catalog command; a missing or unknown sub is a usage error", async () => {
    const root = sqliteProject()
    const cli = join(import.meta.dir, "../src/cli.ts")
    const run = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath, cli, ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { code: await proc.exited, stdout, stderr }
    }
    const query = await run("db", "query", "SELECT count(*) AS n FROM orders", "--json")
    expect(query.code).toBe(0)
    expect(JSON.parse(query.stdout)).toMatchObject({ ok: true, rows: [[2]], untrusted: true })
    const refused = await run("db", "query", "SELECT * FROM sessions")
    expect(refused.code).toBe(1)
    expect(refused.stdout).toContain("✖ NIFRA_DB_TABLE_EXCLUDED")
    for (const args of [["db"], ["db", "drop"]]) {
      const usage = await run(...args)
      expect(usage.code).toBe(1)
      expect(usage.stderr).toContain("nifra db schema|query|role|audit")
    }
  })
})

const PG_URL = process.env.NIFRA_TEST_POSTGRES_URL ?? ""

describe.skipIf(PG_URL === "")(
  PG_URL === ""
    ? "nifra db on Postgres (skipped: set NIFRA_TEST_POSTGRES_URL to a superuser URL of a throwaway server)"
    : "nifra db on Postgres",
  () => {
    const run = `${process.pid}_${Date.now().toString(36)}`
    const database = `nifra_cli_live_${run}`
    const role = `nifra_cli_reader_${run}`
    const password = `cli-${crypto.randomUUID()}`
    let admin: {
      host?: string
      port: number
      username: string
      password?: string
      database: string
    }
    const raw = (name: string) =>
      new SQL({
        adapter: "postgres",
        hostname: admin.host ?? "127.0.0.1",
        port: admin.port,
        username: admin.username,
        ...(admin.password === undefined ? {} : { password: admin.password }),
        database: name,
        max: 1,
      })
    const url = (user: string, secret: string | undefined) =>
      `postgres://${encodeURIComponent(user)}${secret === undefined ? "" : `:${encodeURIComponent(secret)}`}@${admin.host ?? "127.0.0.1"}:${admin.port}/${database}`
    const project = (envUrl: string) => {
      const root = createFixtureProject(parent, "pg-")
      writeFileSync(join(root, ".env.local"), `NIFRA_CLI_LIVE_URL=${envUrl}\n`)
      writeFileSync(
        join(root, "nifra.config.ts"),
        'export const devDatabase = { kind: "postgres", url: process.env.NIFRA_CLI_LIVE_URL, exclude: ["audit_log"], timeoutMs: 1500 }\n',
      )
      return root
    }
    let reader = ""
    let superuser = ""

    beforeAll(async () => {
      const parsed = parsePostgresUrl(PG_URL)
      if (isDbRefusal(parsed)) throw new Error(parsed.message)
      admin = parsed
      const server = raw(admin.database)
      try {
        const [version] = await server`SELECT current_setting('server_version_num')::int AS v`
        await server.unsafe(`CREATE DATABASE "${database}"`)
        await server.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`)
        if (Number(version?.v) >= 140000) await server.unsafe(`GRANT pg_read_all_data TO "${role}"`)
      } finally {
        await server.close()
      }
      const db = raw(database)
      try {
        await db.unsafe(`
          CREATE TABLE accounts (id serial PRIMARY KEY, email text, password_hash text, note text);
          CREATE TABLE audit_log (id int, what text);
          INSERT INTO accounts (email, password_hash, note) VALUES ('a@example.com', 'hash', 'jwt ${JWT}');
          INSERT INTO audit_log VALUES (1, 'secret');
          GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}";
          ANALYZE;
        `)
      } finally {
        await db.close()
      }
      reader = project(url(role, password))
      superuser = project(url(admin.username, admin.password))
    })

    afterAll(async () => {
      if (admin === undefined) return
      const server = raw(admin.database)
      try {
        await server.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
        await server.unsafe(`DROP ROLE IF EXISTS "${role}"`)
      } finally {
        await server.close()
      }
    })

    test("a read-only role: schema, masked rows, plans, refusals and the server timeout", async () => {
      const schema = await dbSchemaSpec.run({}, ctx(reader))
      expect(schema).toMatchObject({
        ok: true,
        engine: "postgres",
        excludedCount: 1,
        untrusted: true,
      })
      expect(schema.tables?.map((table) => table.name)).toEqual(["accounts"])
      const rows = await dbQuerySpec.run(
        { sql: "SELECT email, password_hash, note FROM accounts" },
        ctx(reader),
      )
      expect(rows).toMatchObject({
        ok: true,
        rows: [["a@example.com", "[redacted]", "jwt [redacted:JWT]"]],
        redactedColumns: ["password_hash"],
        untrusted: true,
      })
      const plan = await dbQuerySpec.run(
        { sql: "SELECT count(*) FROM accounts", analyze: true, explain: true },
        ctx(reader),
      )
      expect(plan).toMatchObject({ ok: true, tool: "explain", analyzed: true })
      expect(await dbQuerySpec.run({ sql: "SELECT * FROM audit_log" }, ctx(reader))).toMatchObject({
        refusal: { code: "NIFRA_DB_TABLE_EXCLUDED" },
      })
      expect(await dbQuerySpec.run({ sql: "DELETE FROM accounts" }, ctx(reader))).toMatchObject({
        refusal: { code: "NIFRA_DB_WRITE_REFUSED" },
      })
      const slow = await dbQuerySpec.run({ sql: "SELECT pg_sleep(5)" }, ctx(reader))
      expect(slow).toMatchObject({ refusal: { code: "NIFRA_DB_TIMEOUT" } })
      expect(slow.refusal?.message).toContain("statement timeout")
      const roleSql = await dbRoleSpec.run({}, ctx(reader))
      expect(roleSql.statements).toContain(
        'REVOKE SELECT ON TABLE "public"."audit_log" FROM "nifra_dev_reader";',
      )
      expect(JSON.stringify(roleSql)).not.toContain(password)
    })

    test("a superuser connection: queries refused with the fix, schema and the role SQL still answer", async () => {
      const refused = await dbQuerySpec.run({ sql: "SELECT 1" }, ctx(superuser))
      expect(refused).toMatchObject({ ok: false, refusal: { code: "NIFRA_DB_SUPERUSER" } })
      expect(refused.refusal?.fix).toContain("nifra db role")
      expect((await dbSchemaSpec.run({}, ctx(superuser))).ok).toBe(true)
      const roleSql = await dbRoleSpec.run({}, ctx(superuser))
      expect(
        roleSql.statements?.some((line) => line.startsWith('CREATE ROLE "nifra_dev_reader"')),
      ).toBe(true)
      expect(roleSql.note).toContain("Nothing was run")
      const server = raw(admin.database)
      try {
        const [made] =
          await server`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'nifra_dev_reader'`
        expect(made?.n).toBe(0)
      } finally {
        await server.close()
      }
    })

    test("in process: every Postgres operation through runDbOperation", async () => {
      const db = await loadDevDatabase(reader)
      if (isDbRefusal(db)) throw new Error(db.message)
      expect((await runDbOperation(reader, { op: "schema", table: "accounts" }, db)).ok).toBe(true)
      expect((await runDbOperation(reader, { op: "query", sql: "SELECT 1 AS one" }, db)).ok).toBe(
        true,
      )
      expect((await runDbOperation(reader, { op: "explain", sql: "SELECT 1" }, db)).ok).toBe(true)
      expect(await runDbOperation(reader, { op: "role" }, db)).toMatchObject({
        ok: true,
        role: { role: "nifra_dev_reader" },
      })
      delete process.env.NIFRA_CLI_LIVE_URL
    })
  },
)

describe("nifra mcp over stdio", () => {
  test("nifra_db_schema and nifra_db_query are separate tools; each call runs in its own process", async () => {
    const root = mkdtempSync(join(tmpdir(), "nifra-db-mcp-"))
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "db-mcp",
          type: "module",
          dependencies: { "@nifrajs/core": "0.0.0" },
        }),
      )
      const app = join(root, "app")
      mkdirSync(join(app, "data"), { recursive: true })
      const db = new Database(join(app, "data", "app.db"))
      db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)")
      db.run("INSERT INTO notes (body) VALUES ('one'), ('two')")
      db.close()
      writeFileSync(
        join(app, "nifra.config.ts"),
        [
          'import { appendFileSync } from "node:fs"',
          'appendFileSync(new URL("./pids.log", import.meta.url), String(process.pid) + "\\n")',
          'export const devDatabase = { kind: "sqlite", file: "./data/app.db" }',
        ].join("\n"),
      )
      mkdirSync(join(root, "crash"))
      writeFileSync(join(root, "crash", "nifra.config.ts"), "process.exit(7)\n")
      const call = (id: number, name: string, args: Record<string, unknown>) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      })
      const responses = await mcpRpc(
        root,
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "t", version: "1" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          call(3, "nifra_db_schema", { dir: "app" }),
          call(4, "nifra_db_query", { dir: "app", sql: "SELECT count(*) AS n FROM notes" }),
          call(5, "nifra_db_query", { dir: "app", sql: "SELECT body FROM notes ORDER BY id" }),
          call(6, "nifra_db_query", { dir: "crash", sql: "SELECT 1" }),
          call(7, "nifra_db_query", { dir: "../outside", sql: "SELECT 1" }),
        ],
        [2, 3, 4, 5, 6, 7],
      )
      const tools = (
        responses[2] as { result: { tools: { name: string; inputSchema: unknown }[] } }
      ).result.tools
      const names = tools.map((tool) => tool.name)
      expect(names).toContain("nifra_db_schema")
      expect(names).toContain("nifra_db_query")
      expect(names).toContain("nifra_db_role")
      expect(names).not.toContain("nifra_db_audit")
      const raw = (id: number) =>
        (responses[id] as { result: { content: { text: string }[] } }).result.content[0]?.text ?? ""
      const text = (id: number) => JSON.parse(raw(id))
      expect(text(3)).toMatchObject({ ok: true, tool: "schema", untrusted: true })
      expect(text(4)).toMatchObject({ ok: true, rows: [[2]], untrusted: true })
      expect(text(5)).toMatchObject({ ok: true, rows: [["one"], ["two"]] })
      expect(text(6)).toMatchObject({
        ok: false,
        refusal: {
          code: "NIFRA_DB_DRIVER",
          message: "the database process exited with code 7 before answering",
        },
      })
      expect(text(7)).toMatchObject({ ok: false })
      const pids = readFileSync(join(app, "pids.log"), "utf8").trim().split("\n")
      expect(pids).toHaveLength(3)
      expect(new Set(pids).size).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

/** Drive `nifra mcp` over stdio until every expected id has answered (see mcp.test.ts). */
async function mcpRpc(
  dir: string,
  messages: object[],
  ids: number[],
): Promise<Record<number, unknown>> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "mcp"], {
    cwd: dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  for (const message of messages) proc.stdin.write(`${JSON.stringify(message)}\n`)
  const byId: Record<number, unknown> = {}
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  const deadline = Date.now() + 45_000
  try {
    while (ids.some((id) => byId[id] === undefined) && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((done) =>
          setTimeout(() => done({ done: true, value: undefined }), 45_000),
        ),
      ])
      if (chunk.done) break
      buffered += decoder.decode(chunk.value, { stream: true })
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("{")) continue
        const parsed = JSON.parse(line) as { id?: number }
        if (typeof parsed.id === "number") byId[parsed.id] = parsed
      }
    }
  } finally {
    reader.cancel().catch(() => {})
    proc.kill()
    await proc.exited.catch(() => 0)
  }
  return byId
}
