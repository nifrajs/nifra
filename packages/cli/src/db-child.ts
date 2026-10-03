/**
 * The `nifra db` subprocess. The parent (`db-tool.ts`) spawns a fresh one per call: it applies the
 * project's `.env` files, imports `nifra.config.ts`, reports the declared deadline, opens the database,
 * runs one operation, prints the answer and exits. The parent kills it at the deadline, so the deadline
 * bounds the work and not only the response.
 *
 * Protocol: one JSON request on stdin; answers on stdout as lines prefixed with the request's token,
 * so anything the config prints cannot be read as an answer.
 */

import {
  type DbPlan,
  type DbRedaction,
  type DbRefusal,
  type DbRows,
  type DbSchemaReport,
  dbRefusal,
  explainSqlite,
  isDbRefusal,
  openReadOnlySqlite,
  querySqlite,
  readSqliteSchema,
  resolveSqliteFile,
} from "@nifrajs/mcp-db/engine"
import {
  connectPostgres,
  explainPostgres,
  type PostgresRoleSql,
  parsePostgresUrl,
  postgresRoleSql,
  queryPostgres,
  readPostgresSchema,
} from "@nifrajs/mcp-db/postgres"
import { createDevFeed } from "@nifrajs/web/dev-feed"
import { isSensitiveFieldName } from "@nifrajs/web/zones"
import { type DevDatabase, loadDevDatabase } from "./db-config.ts"
import { CHILD_INPUT_MAX_BYTES, readBoundedStream } from "./mcp-io.ts"

/** The one operation a subprocess runs. */
export interface DbChildRequest {
  readonly op: "schema" | "query" | "explain" | "role"
  readonly sql?: string | undefined
  readonly table?: string | undefined
  readonly analyze?: boolean | undefined
}

/** What an operation produced, before the parent adds timing and the untrusted-data note. */
export type DbChildAnswer =
  | {
      readonly ok: true
      readonly engine: DevDatabase["kind"]
      readonly database: string
      readonly durationMs: number
      readonly schema?: DbSchemaReport
      readonly rows?: DbRows
      readonly plan?: DbPlan
      readonly role?: Omit<PostgresRoleSql, "serverVersionNum"> | { readonly statements: [] }
    }
  | {
      readonly ok: false
      readonly engine?: DevDatabase["kind"] | undefined
      readonly database?: string | undefined
      readonly durationMs: number
      readonly refusal: DbRefusal
    }

/** The lines a subprocess writes, after its token. */
export type DbChildMessage =
  | { readonly type: "ready"; readonly timeoutMs: number }
  | { readonly type: "answer"; readonly answer: DbChildAnswer }

const lower = (name: string): string => name.toLowerCase()

/**
 * The masked columns a query may not read (the credential-name classifier, plus `redactColumns`,
 * minus `revealColumns`) and the dev feed's text redactor for every string value.
 */
export function dbRedaction(
  root: string,
  db: DevDatabase,
  env: Readonly<Record<string, string | undefined>> = process.env,
): DbRedaction {
  const redact = new Set(db.redactColumns.map(lower))
  const reveal = new Set(db.revealColumns.map(lower))
  const feed = createDevFeed({ root, persist: false, env })
  return {
    column: (name) =>
      !reveal.has(lower(name)) && (isSensitiveFieldName(name) || redact.has(lower(name))),
    text: (value) => feed.redact(value),
  }
}

const QUERY_OFF = (): DbRefusal =>
  dbRefusal("NIFRA_DB_QUERY_OFF", "devDatabase.query is false: only the schema tool is on")

async function runSqlite(
  root: string,
  request: DbChildRequest,
  db: Extract<DevDatabase, { kind: "sqlite" }>,
  redaction: DbRedaction,
): Promise<Omit<Extract<DbChildAnswer, { ok: true }>, "durationMs"> | DbRefusal> {
  if (request.op === "role") {
    return { ok: true, engine: "sqlite", database: db.file, role: { statements: [] } }
  }
  if (request.op !== "schema" && !db.query) return QUERY_OFF()
  const file = resolveSqliteFile(root, db.file, db.allowFiles)
  if (isDbRefusal(file)) return file
  let handle: Awaited<ReturnType<typeof openReadOnlySqlite>>
  try {
    handle = await openReadOnlySqlite(file)
  } catch (error) {
    return dbRefusal("NIFRA_DB_DRIVER", `could not open ${db.file}: ${String(error)}`)
  }
  try {
    const base = { ok: true as const, engine: "sqlite" as const, database: db.file }
    if (request.op === "schema") {
      const schema = readSqliteSchema(handle, {
        exclude: db.exclude,
        redaction,
        table: request.table,
      })
      return isDbRefusal(schema) ? schema : { ...base, schema }
    }
    if (request.op === "explain") {
      const plan = explainSqlite(handle, request.sql ?? "", db)
      return isDbRefusal(plan) ? plan : { ...base, plan }
    }
    const rows = querySqlite(handle, request.sql ?? "", { ...db, redaction })
    return isDbRefusal(rows) ? rows : { ...base, rows }
  } finally {
    handle.close()
  }
}

async function runPostgres(
  request: DbChildRequest,
  db: Extract<DevDatabase, { kind: "postgres" }>,
  redaction: DbRedaction,
): Promise<Omit<Extract<DbChildAnswer, { ok: true }>, "durationMs"> | DbRefusal> {
  if ((request.op === "query" || request.op === "explain") && !db.query) return QUERY_OFF()
  const target = parsePostgresUrl(db.url)
  if (isDbRefusal(target)) return target
  const database = `${target.host ?? target.socket}:${target.port}/${target.database}`
  const client = connectPostgres(target, db)
  if (isDbRefusal(client)) return client
  const base = { ok: true as const, engine: "postgres" as const, database }
  try {
    if (request.op === "schema") {
      const schema = await readPostgresSchema(client, {
        ...db,
        redaction,
        table: request.table,
      })
      return isDbRefusal(schema) ? schema : { ...base, schema }
    }
    if (request.op === "role") {
      const role = await postgresRoleSql(client, db)
      if (isDbRefusal(role)) return role
      return {
        ...base,
        role: { role: role.role, database: role.database, statements: role.statements },
      }
    }
    if (request.op === "explain") {
      const plan = await explainPostgres(client, request.sql ?? "", {
        ...db,
        redaction,
        analyze: request.analyze === true,
      })
      return isDbRefusal(plan) ? plan : { ...base, plan }
    }
    const rows = await queryPostgres(client, request.sql ?? "", { ...db, redaction })
    return isDbRefusal(rows) ? rows : { ...base, rows }
  } finally {
    await client.close({ timeout: 0 }).catch(() => {})
  }
}

/** Run one operation against a loaded declaration. Every refusal message is redacted too. */
export async function runDbOperation(
  root: string,
  request: DbChildRequest,
  db: DevDatabase,
): Promise<DbChildAnswer> {
  const started = performance.now()
  const redaction = dbRedaction(root, db)
  let outcome: Omit<Extract<DbChildAnswer, { ok: true }>, "durationMs"> | DbRefusal
  try {
    outcome =
      db.kind === "sqlite"
        ? await runSqlite(root, request, db, redaction)
        : await runPostgres(request, db, redaction)
  } catch (error) {
    outcome = dbRefusal("NIFRA_DB_DRIVER", error instanceof Error ? error.message : String(error))
  }
  const durationMs = Math.round(performance.now() - started)
  if (!isDbRefusal(outcome)) return { ...outcome, durationMs }
  return {
    ok: false,
    engine: db.kind,
    durationMs,
    refusal: { ...outcome, message: redaction.text?.(outcome.message) ?? outcome.message },
  }
}

const OPS = ["schema", "query", "explain", "role"] as const

/** Validate the parent's request (it crosses a process boundary). */
export function parseDbChildRequest(
  text: string,
): (DbChildRequest & { readonly token: string }) | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const field = (key: string): unknown => Reflect.get(value, key)
  const token = field("token")
  const op = OPS.find((name) => name === field("op"))
  const sql = field("sql")
  const table = field("table")
  const analyze = field("analyze")
  if (typeof token !== "string" || !/^[0-9a-f-]{16,64}$/.test(token)) return undefined
  if (op === undefined) return undefined
  if (sql !== undefined && typeof sql !== "string") return undefined
  if (table !== undefined && typeof table !== "string") return undefined
  if (analyze !== undefined && typeof analyze !== "boolean") return undefined
  return { token, op, sql, table, analyze }
}

/**
 * Serve one request: read it from `input`, load the declaration, report the deadline, run the
 * operation and write the answer through `write`, each line prefixed with the request's token.
 * Returns false (writing nothing) for a malformed request.
 */
export async function serveDbChild(
  root: string,
  input: ReadableStream<Uint8Array>,
  write: (line: string) => Promise<void>,
): Promise<boolean> {
  const text = await readBoundedStream(input, CHILD_INPUT_MAX_BYTES)
  const request = text.truncated ? undefined : parseDbChildRequest(text.text)
  if (request === undefined) return false
  const send = (message: DbChildMessage): Promise<void> =>
    write(`${request.token} ${JSON.stringify(message)}\n`)
  const started = performance.now()
  let answer: DbChildAnswer
  try {
    const db = await loadDevDatabase(root)
    if (isDbRefusal(db)) {
      answer = { ok: false, durationMs: Math.round(performance.now() - started), refusal: db }
    } else {
      await send({ type: "ready", timeoutMs: db.timeoutMs })
      answer = await runDbOperation(root, request, db)
    }
  } catch (error) {
    answer = {
      ok: false,
      durationMs: Math.round(performance.now() - started),
      refusal: dbRefusal("NIFRA_DB_DRIVER", error instanceof Error ? error.message : String(error)),
    }
  }
  await send({ type: "answer", answer })
  return true
}

if (import.meta.main) {
  // Bound before the config loads, so nothing it patches can reach the protocol channel.
  const stdout = process.stdout.write.bind(process.stdout)
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((arg) => String(arg)).join(" ")}\n`)
  }
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  const served = await serveDbChild(
    process.argv[2] ?? process.cwd(),
    Bun.stdin.stream(),
    (line) => new Promise((done) => stdout(line, () => done())),
  )
  if (!served) process.stderr.write("nifra db: invalid request\n")
  process.exit(served ? 0 : 2)
}
