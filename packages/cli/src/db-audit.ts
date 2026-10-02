/**
 * `.nifra/db-audit.jsonl`: one line per `nifra db` call - what ran, never what came back. Each entry
 * carries the SQL (secrets redacted), its fingerprint, the row count, the duration and the refusal
 * code. The file is owner-only, never followed through a symlink, and rotates at 1 MB to
 * `db-audit.1.jsonl`, so it stays bounded.
 */

import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs"
import { resolve } from "node:path"
import type { DbRefusalCode } from "@nifrajs/mcp-db/engine"

export const DB_AUDIT_FILE = ".nifra/db-audit.jsonl"
export const DB_AUDIT_ROTATED_FILE = ".nifra/db-audit.1.jsonl"
export const DB_AUDIT_MAX_BYTES = 1024 * 1024

/** One audited call. */
export interface DbAuditEntry {
  readonly at: string
  readonly tool: "schema" | "query" | "explain" | "role"
  readonly engine?: "sqlite" | "postgres" | undefined
  /** The statement, secrets redacted. */
  readonly sql?: string | undefined
  /** Stable across literal values and whitespace, so repeated shapes group together. */
  readonly fingerprint?: string | undefined
  readonly table?: string | undefined
  readonly ok: boolean
  readonly code?: DbRefusalCode | undefined
  readonly rowCount?: number | undefined
  readonly durationMs: number
}

/** A statement's shape: literals become `?`, whitespace collapses, case folds; hashed. */
export function sqlFingerprint(sql: string): string {
  const shape = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  return createHash("sha256").update(shape).digest("hex").slice(0, 16)
}

/** True when `path` exists and is a symlink: the audit never writes through one. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Append one entry. Returns false (and writes nothing) when `.nifra` or the log is a symlink or the
 * write fails - an audit problem never fails the call it records.
 */
export function appendDbAudit(root: string, entry: DbAuditEntry): boolean {
  const dir = resolve(root, ".nifra")
  const file = resolve(root, DB_AUDIT_FILE)
  try {
    if (isSymlink(dir)) return false
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (isSymlink(file)) return false
    const line = `${JSON.stringify(entry)}\n`
    if (existsSync(file) && lstatSync(file).size + Buffer.byteLength(line) > DB_AUDIT_MAX_BYTES) {
      const rotated = resolve(root, DB_AUDIT_ROTATED_FILE)
      if (isSymlink(rotated)) return false
      renameSync(file, rotated)
    }
    const fd = openSync(
      file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      writeSync(fd, line)
    } finally {
      closeSync(fd)
    }
    chmodSync(file, 0o600)
    return true
  } catch {
    return false
  }
}

const isEntry = (value: unknown): value is DbAuditEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { at?: unknown }).at === "string" &&
  typeof (value as { tool?: unknown }).tool === "string" &&
  typeof (value as { ok?: unknown }).ok === "boolean"

/** The newest `limit` entries, oldest first, across the current and the rotated file. */
export function readDbAudit(root: string, limit: number): DbAuditEntry[] {
  const entries: DbAuditEntry[] = []
  for (const name of [DB_AUDIT_ROTATED_FILE, DB_AUDIT_FILE]) {
    const path = resolve(root, name)
    if (!existsSync(path) || isSymlink(path)) continue
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isEntry(parsed)) entries.push(parsed)
      } catch {
        // A torn last line from a killed writer is skipped, not fatal.
      }
    }
  }
  return entries.slice(-limit)
}
