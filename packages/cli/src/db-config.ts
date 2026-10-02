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
  /** Columns masked in results on top of the credential-name classifier. */
  readonly redactColumns: readonly string[]
  /** Columns the classifier would mask that results may show. */
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

const invalid = (message: string): never => {
  throw new InvalidDeclaration(message)
}

function strings(raw: Record<string, unknown>, field: string): readonly string[] {
  const value = raw[field]
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "")) {
    invalid(`devDatabase.${field} must be an array of non-empty strings`)
  }
  return value as string[]
}

function integer(
  raw: Record<string, unknown>,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw[field]
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`devDatabase.${field} must be an integer from ${min} to ${max}`)
  }
  return value as number
}

/** Validate a `devDatabase` export and apply defaults. Unknown fields are refused, never ignored. */
export function parseDevDatabase(value: unknown): DevDatabase | DbRefusal {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      invalid('devDatabase must be an object such as { kind: "sqlite", file: "./data/app.db" }')
    }
    const raw = value as Record<string, unknown>
    const kind =
      raw.kind === "sqlite" || raw.kind === "postgres"
        ? raw.kind
        : invalid('devDatabase.kind must be "sqlite" or "postgres"')
    const known = kind === "sqlite" ? SQLITE_FIELDS : POSTGRES_FIELDS
    for (const field of Object.keys(raw)) {
      if (!known.has(field))
        invalid(`devDatabase has no field ${JSON.stringify(field)} for kind ${kind}`)
    }
    if (raw.query !== undefined && typeof raw.query !== "boolean") {
      invalid("devDatabase.query must be a boolean")
    }
    const common: DevDatabaseCommon = {
      exclude: strings(raw, "exclude"),
      maxRows: integer(raw, "maxRows", 100, 1, 10_000),
      // The answer crosses the subprocess pipe as one line, bounded at 1 MiB with its envelope.
      maxResultBytes: integer(raw, "maxResultBytes", 100 * 1024, 1024, 512 * 1024),
      timeoutMs: integer(raw, "timeoutMs", 5_000, 100, 120_000),
      redactColumns: strings(raw, "redactColumns"),
      revealColumns: strings(raw, "revealColumns"),
      query: raw.query !== false,
    }
    if (kind === "sqlite") {
      if (typeof raw.file !== "string" || raw.file === "" || raw.file.startsWith(":memory:")) {
        invalid("devDatabase.file must be the path of a SQLite database file")
      }
      return { ...common, kind, file: raw.file as string, allowFiles: strings(raw, "allowFiles") }
    }
    if (raw.url === undefined) {
      invalid(
        `devDatabase.url is undefined: the environment variable it reads is not set (nifra applies ${DEV_DATABASE_ENV_FILES.join(", ")} first)`,
      )
    }
    if (typeof raw.url !== "string" || raw.url === "") {
      invalid("devDatabase.url must be a postgres:// URL")
    }
    return {
      ...common,
      kind,
      url: raw.url as string,
      allowHosts: strings(raw, "allowHosts"),
      allowExtensions: strings(raw, "allowExtensions"),
      schemas: raw.schemas === undefined ? ["public"] : strings(raw, "schemas"),
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
  let config: { devDatabase?: unknown }
  try {
    config = (await import(configPath)) as { devDatabase?: unknown }
  } catch (error) {
    return dbRefusal(
      "NIFRA_DB_CONFIG",
      `${CONFIG_FILE} failed to load: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (config.devDatabase === undefined) {
    return dbRefusal("NIFRA_DB_NOT_DECLARED", `${CONFIG_FILE} does not export devDatabase`)
  }
  return parseDevDatabase(config.devDatabase)
}
