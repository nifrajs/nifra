/**
 * The `devDatabase` declaration in `nifra.config.ts`: the one database `nifra db` / `nifra_db_*` may
 * read. Declared explicitly or not at all - `DATABASE_URL` is never read on its own, because it often
 * points at production.
 *
 *   export const devDatabase = { kind: "sqlite", file: "./data/app.db" }
 *   export const devDatabase = {
 *     kind: "postgres",
 *     url: process.env.NIFRA_DEV_DATABASE_URL,
 *     exclude: ["audit_log"],
 *   }
 *
 * The config is imported only inside the query subprocess (`db-child.ts`), after `.env` files load.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { type DbRefusal, dbRefusal } from "@nifrajs/mcp-db/engine"
import { CONFIG_FILE } from "./app-files.ts"
import { applyEnvFiles, parseEnvFile } from "./env-file.ts"

/** Fields both engines share, with their defaults applied. */
export interface DevDatabaseCommon {
  /** Tables a query may not read (`name`, or `schema.name` on Postgres). */
  readonly exclude: readonly string[]
  readonly maxRows: number
  readonly maxResultBytes: number
  readonly timeoutMs: number
  /** Columns a query may not read, on top of the credential-name classifier. */
  readonly redactColumns: readonly string[]
  /** Columns the classifier names that a query may read anyway. */
  readonly revealColumns: readonly string[]
  /** `nifra db query` is on for a declared database unless this is false. */
  readonly query: boolean
}

export interface DevSqliteDatabase extends DevDatabaseCommon {
  readonly kind: "sqlite"
  /** Relative to the project root; its real path must stay inside the root. */
  readonly file: string
  /** Paths outside the root that `file` may resolve to. */
  readonly allowFiles: readonly string[]
}

export interface DevPostgresDatabase extends DevDatabaseCommon {
  readonly kind: "postgres"
  readonly url: string
  /** Remote hosts the URL may name; loopback, `*.localhost` and unix sockets need no entry. */
  readonly allowHosts: readonly string[]
  /** Extensions or untrusted languages the role may use without the query being refused. */
  readonly allowExtensions: readonly string[]
  /** Schemas a query may read (default `["public"]`). */
  readonly schemas: readonly string[]
}

export type DevDatabase = DevSqliteDatabase | DevPostgresDatabase

const COMMON_FIELDS = [
  "kind",
  "exclude",
  "maxRows",
  "maxResultBytes",
  "timeoutMs",
  "redactColumns",
  "revealColumns",
  "query",
] as const
const SQLITE_FIELDS = new Set<string>([...COMMON_FIELDS, "file", "allowFiles"])
const POSTGRES_FIELDS = new Set<string>([
  ...COMMON_FIELDS,
  "url",
  "allowHosts",
  "allowExtensions",
  "schemas",
])

/** The `.env` files the subprocess applies, lowest precedence first; the process env wins over all. */
export const DEV_DATABASE_ENV_FILES = [
  ".env",
  ".env.development",
  ".env.local",
  ".env.development.local",
] as const

class InvalidDeclaration extends Error {}

function invalid(message: string): never {
  throw new InvalidDeclaration(message)
}

/** One field of the declaration object, read without trusting its shape. */
type Fields = (field: string) => unknown

function strings(fields: Fields, field: string): readonly string[] {
  const value = fields(field)
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid(`devDatabase.${field} must be an array of non-empty strings`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      invalid(`devDatabase.${field} must be an array of non-empty strings`)
    }
    out.push(item)
  }
  return out
}

function integer(
  fields: Fields,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = fields(field)
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`devDatabase.${field} must be an integer from ${min} to ${max}`)
  }
  return value
}

/** Validate a `devDatabase` export and apply defaults. Unknown fields are refused, never ignored. */
export function parseDevDatabase(value: unknown): DevDatabase | DbRefusal {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      invalid('devDatabase must be an object such as { kind: "sqlite", file: "./data/app.db" }')
    }
    const fields: Fields = (field) => Reflect.get(value, field)
    const declared = fields("kind")
    const kind =
      declared === "sqlite" || declared === "postgres"
        ? declared
        : invalid('devDatabase.kind must be "sqlite" or "postgres"')
    const known = kind === "sqlite" ? SQLITE_FIELDS : POSTGRES_FIELDS
    for (const field of Object.keys(value)) {
      if (!known.has(field))
        invalid(`devDatabase has no field ${JSON.stringify(field)} for kind ${kind}`)
    }
    const query = fields("query")
    if (query !== undefined && typeof query !== "boolean") {
      invalid("devDatabase.query must be a boolean")
    }
    const common: DevDatabaseCommon = {
      exclude: strings(fields, "exclude"),
      maxRows: integer(fields, "maxRows", 100, 1, 10_000),
      // The answer crosses the subprocess pipe as one line, bounded at 1 MiB with its envelope.
      maxResultBytes: integer(fields, "maxResultBytes", 100 * 1024, 1024, 512 * 1024),
      timeoutMs: integer(fields, "timeoutMs", 5_000, 100, 120_000),
      redactColumns: strings(fields, "redactColumns"),
      revealColumns: strings(fields, "revealColumns"),
      query: query !== false,
    }
    if (kind === "sqlite") {
      const file = fields("file")
      if (typeof file !== "string" || file === "" || file.startsWith(":memory:")) {
        invalid("devDatabase.file must be the path of a SQLite database file")
      }
      return { ...common, kind, file, allowFiles: strings(fields, "allowFiles") }
    }
    const url = fields("url")
    if (url === undefined) {
      invalid(
        `devDatabase.url is undefined: the environment variable it reads is not set (nifra applies ${DEV_DATABASE_ENV_FILES.join(", ")} first)`,
      )
    }
    if (typeof url !== "string" || url === "") {
      invalid("devDatabase.url must be a postgres:// URL")
    }
    return {
      ...common,
      kind,
      url,
      allowHosts: strings(fields, "allowHosts"),
      allowExtensions: strings(fields, "allowExtensions"),
      schemas: fields("schemas") === undefined ? ["public"] : strings(fields, "schemas"),
    }
  } catch (error) {
    if (error instanceof InvalidDeclaration) return dbRefusal("NIFRA_DB_CONFIG", error.message)
    throw error
  }
}

/** The project's `.env` files as one record, for redacting with the values the subprocess sees. */
export async function readProjectEnv(root: string): Promise<Record<string, string>> {
  const merged: Record<string, string> = {}
  for (const file of DEV_DATABASE_ENV_FILES) {
    const path = resolve(root, file)
    if (!existsSync(path)) continue
    Object.assign(merged, parseEnvFile(await Bun.file(path).text()))
  }
  return merged
}

/**
 * Apply the project's `.env` files (never overriding the process environment), then import
 * `nifra.config.ts` and validate its `devDatabase` export. Runs in the query subprocess only: the
 * config is code, and importing it in a long-lived process would pin its modules.
 */
export async function loadDevDatabase(root: string): Promise<DevDatabase | DbRefusal> {
  await applyEnvFiles(
    root,
    DEV_DATABASE_ENV_FILES.filter((file) => existsSync(resolve(root, file))),
  )
  const configPath = resolve(root, CONFIG_FILE)
  if (!existsSync(configPath)) {
    return dbRefusal("NIFRA_DB_NOT_DECLARED", `${root} has no ${CONFIG_FILE} declaring devDatabase`)
  }
  let config: unknown
  try {
    config = await import(configPath)
  } catch (error) {
    return dbRefusal(
      "NIFRA_DB_CONFIG",
      `${CONFIG_FILE} failed to load: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const declared =
    typeof config === "object" && config !== null ? Reflect.get(config, "devDatabase") : undefined
  if (declared === undefined) {
    return dbRefusal("NIFRA_DB_NOT_DECLARED", `${CONFIG_FILE} does not export devDatabase`)
  }
  return parseDevDatabase(declared)
}
