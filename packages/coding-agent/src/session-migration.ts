import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

/** Version of the evidence-only legacy session file format. */
export const SESSION_EVIDENCE_VERSION = 1 as const

const HEX64 = /^[0-9a-f]{64}$/
const SESSION_TOKEN = /^[a-zA-Z0-9._:-]{1,128}$/
const EVENT_TYPE = /^[a-z][a-z0-9._:-]{0,63}$/
const MAX_SOURCE_BYTES = 64 * 1024 * 1024

/**
 * A single legacy session record after content has been removed.
 *
 * `digest` covers this record without the digest field. It is an integrity identifier, not a
 * digest of the legacy payload. The payload is never written to the migration target.
 */
export interface SessionEvidenceRecord {
  readonly version: typeof SESSION_EVIDENCE_VERSION
  readonly sessionId: string
  readonly seq: number
  readonly at: number
  readonly code: string
  readonly count: 1
  readonly digest: string
  readonly pinned?: boolean
}

/** Counts and integrity metadata emitted after a target has been fully validated. */
export interface SessionMigrationReport {
  readonly version: typeof SESSION_EVIDENCE_VERSION
  readonly sessionId: string
  readonly records: number
  /** Number of source event types replaced by the stable unknown-event code. */
  readonly skipped: number
  readonly skippedByCode: Readonly<Record<string, number>>
  readonly counts: Readonly<Record<string, number>>
  readonly firstSeq?: number
  readonly lastSeq?: number
  /** Digest of the complete evidence-only target file, including line separators. */
  readonly digest: string
}

export interface MigrateLegacySessionOptions {
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly sessionId: string
  /** Abort before any target commit. The legacy source is never modified. */
  readonly signal?: AbortSignal
  /** Bound the amount of legacy data read into transient memory. */
  readonly maxSourceBytes?: number
}

export class SessionMigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`session migration [${code}]: ${message}`)
    this.name = "SessionMigrationError"
  }
}

/**
 * Convert a legacy event type into a stable, content-free evidence code.
 * Unknown event names are intentionally not copied to the target: their SHA-256 prefix gives a
 * repeatable grouping key without disclosing an arbitrary source string.
 */
export async function stableSessionEventCode(
  type: string,
): Promise<{ readonly code: string; readonly replaced: boolean }> {
  if (KNOWN_EVENT_CODES.has(type)) return { code: type, replaced: false }
  const digest = await sha256Hex(type)
  return { code: `legacy.unknown.${digest.slice(0, 16)}`, replaced: true }
}

/** Parse one evidence record strictly. Payload-bearing or unknown fields are rejected. */
export function parseSessionEvidenceRecord(value: unknown): SessionEvidenceRecord {
  if (!isRecord(value))
    throw new SessionMigrationError("invalid_record", "record must be an object")
  const allowed = ["version", "sessionId", "seq", "at", "code", "count", "digest", "pinned"]
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new SessionMigrationError("invalid_record", `unknown evidence field '${key}'`)
  if (value.version !== SESSION_EVIDENCE_VERSION)
    throw new SessionMigrationError("invalid_record", "unsupported evidence version")
  const sessionId = requiredToken(value.sessionId, "sessionId")
  const seq = nonNegativeInteger(value.seq, "seq")
  const at = nonNegativeInteger(value.at, "at")
  const code = requiredCode(value.code)
  if (value.count !== 1) throw new SessionMigrationError("invalid_record", "count must be 1")
  const digest = value.digest
  if (typeof digest !== "string" || !HEX64.test(digest))
    throw new SessionMigrationError("invalid_record", "digest must be sha256 hex")
  if (value.pinned !== undefined && typeof value.pinned !== "boolean")
    throw new SessionMigrationError("invalid_record", "pinned must be boolean")
  return {
    version: SESSION_EVIDENCE_VERSION,
    sessionId,
    seq,
    at,
    code,
    count: 1,
    digest,
    ...(value.pinned === true ? { pinned: true } : {}),
  }
}

/** Read, project, validate, and atomically commit one legacy local session. */
export async function migrateLegacySession(
  options: MigrateLegacySessionOptions,
): Promise<SessionMigrationReport> {
  assertNotAborted(options.signal)
  const sourceRoot = resolve(options.sourceRoot)
  const targetRoot = resolve(options.targetRoot)
  const sessionId = validateSessionId(options.sessionId)
  const maxSourceBytes = options.maxSourceBytes ?? MAX_SOURCE_BYTES
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1)
    throw new SessionMigrationError("invalid_options", "maxSourceBytes must be positive")
  if (
    sourceRoot === targetRoot ||
    isWithin(sourceRoot, targetRoot) ||
    isWithin(targetRoot, sourceRoot)
  )
    throw new SessionMigrationError(
      "overlapping_roots",
      "sourceRoot and targetRoot must be separate directories",
    )

  const sourceEntries = await readLegacyEntries(sourceRoot, sessionId, maxSourceBytes)
  const records: SessionEvidenceRecord[] = []
  const counts: Record<string, number> = Object.create(null) as Record<string, number>
  const skippedByCode: Record<string, number> = Object.create(null) as Record<string, number>
  let previousSeq = -1
  for (const entry of sourceEntries) {
    assertNotAborted(options.signal)
    if (entry.seq <= previousSeq)
      throw new SessionMigrationError("invalid_source", "legacy sequence must increase strictly")
    previousSeq = entry.seq
    const mapped = await stableSessionEventCode(entry.type)
    const base = {
      version: SESSION_EVIDENCE_VERSION,
      sessionId,
      seq: entry.seq,
      at: entry.at,
      code: mapped.code,
      count: 1 as const,
      ...(entry.pinned === true ? { pinned: true } : {}),
    }
    const record: SessionEvidenceRecord = {
      ...base,
      digest: await sha256Hex(JSON.stringify(base)),
    }
    parseSessionEvidenceRecord(record)
    records.push(Object.freeze(record))
    counts[mapped.code] = (counts[mapped.code] ?? 0) + 1
    if (mapped.replaced) skippedByCode[mapped.code] = (skippedByCode[mapped.code] ?? 0) + 1
  }

  const lines = records.map((record) => JSON.stringify(record))
  const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`
  const digest = await sha256Hex(content)
  const targetFile = join(targetRoot, `${sessionId}.jsonl`)
  await commitTarget(targetRoot, targetFile, content, options.signal)
  // Re-read the committed target and validate every line before the caller treats this as active.
  const committed = await readEvidenceTarget(targetFile, sessionId)
  if (committed.records.length !== records.length || (await sha256Hex(committed.raw)) !== digest)
    throw new SessionMigrationError("target_validation", "committed evidence target changed")
  for (let index = 0; index < committed.records.length; index++) {
    const actual = committed.records[index]!
    const expected = records[index]!
    if (canonicalRecord(actual) !== canonicalRecord(expected))
      throw new SessionMigrationError("target_validation", "committed evidence record differs")
  }
  const report: SessionMigrationReport = {
    version: SESSION_EVIDENCE_VERSION,
    sessionId,
    records: records.length,
    skipped: Object.values(skippedByCode).reduce((sum, value) => sum + value, 0),
    skippedByCode: Object.freeze({ ...skippedByCode }),
    counts: Object.freeze({ ...counts }),
    ...(records[0] === undefined ? {} : { firstSeq: records[0].seq }),
    ...(records.at(-1) === undefined ? {} : { lastSeq: records.at(-1)!.seq }),
    digest,
  }
  return Object.freeze(report)
}

const KNOWN_EVENT_CODES = new Set([
  "session.started",
  "session.updated",
  "turn.started",
  "assistant.delta",
  "assistant.message",
  "tool.started",
  "tool.delta",
  "tool.completed",
  "approval.required",
  "approval.resolved",
  "repair.required",
  "verification.completed",
  "memory.compacted",
  "extension.reloaded",
  "session.completed",
  "session.failed",
  "session.stopped",
  "session.checkpoint",
  "session.forked",
])

interface LegacyEntry {
  readonly sessionId: string
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly pinned?: boolean
}

async function readLegacyEntries(
  sourceRoot: string,
  sessionId: string,
  maxSourceBytes: number,
): Promise<readonly LegacyEntry[]> {
  const path = join(sourceRoot, `${sessionId}.jsonl`)
  let text: string
  try {
    const bytes = await readFile(path)
    if (bytes.byteLength > maxSourceBytes)
      throw new SessionMigrationError("source_too_large", "legacy session exceeds maxSourceBytes")
    text = bytes.toString("utf8")
  } catch (error) {
    if (isNotFound(error)) return Object.freeze([])
    throw error
  }
  const entries: LegacyEntry[] = []
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new SessionMigrationError("invalid_source", `legacy line ${index + 1} is not JSON`)
    }
    if (!isRecord(value))
      throw new SessionMigrationError("invalid_source", `legacy line ${index + 1} is not an object`)
    if (value.version !== 1 || value.sessionId !== sessionId)
      throw new SessionMigrationError(
        "invalid_source",
        `legacy line ${index + 1} has invalid identity`,
      )
    const seq = nonNegativeInteger(value.seq, `legacy line ${index + 1}.seq`)
    const at = nonNegativeInteger(value.at, `legacy line ${index + 1}.at`)
    if (typeof value.type !== "string" || !EVENT_TYPE.test(value.type))
      throw new SessionMigrationError("invalid_source", `legacy line ${index + 1} has invalid type`)
    if (value.pinned !== undefined && typeof value.pinned !== "boolean")
      throw new SessionMigrationError(
        "invalid_source",
        `legacy line ${index + 1} has invalid pinned flag`,
      )
    entries.push({
      sessionId,
      seq,
      at,
      type: value.type,
      ...(value.pinned === true ? { pinned: true } : {}),
    })
  }
  return Object.freeze(entries)
}

async function commitTarget(
  targetRoot: string,
  targetFile: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(targetRoot, { recursive: true, mode: 0o700 })
  try {
    await access(targetFile)
    throw new SessionMigrationError("target_exists", "migration target already exists")
  } catch (error) {
    if (!(error instanceof SessionMigrationError) && !isNotFound(error)) throw error
    if (error instanceof SessionMigrationError) throw error
  }
  assertNotAborted(signal)
  const temporary = join(targetRoot, `.${basename(targetFile)}.${process.pid}.${randomToken()}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" })
    assertNotAborted(signal)
    // The target is created only after the complete temporary file exists. A pre-existing target
    // was rejected above; callers must treat a concurrent target race as a failed migration.
    try {
      await access(targetFile)
      throw new SessionMigrationError("target_exists", "migration target appeared during migration")
    } catch (error) {
      if (error instanceof SessionMigrationError) throw error
      if (!isNotFound(error)) throw error
    }
    await rename(temporary, targetFile)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function readEvidenceTarget(
  path: string,
  sessionId: string,
): Promise<{ readonly records: readonly SessionEvidenceRecord[]; readonly raw: string }> {
  const raw = await readFile(path, "utf8")
  const records: SessionEvidenceRecord[] = []
  let previousSeq = -1
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue
    const record = parseSessionEvidenceRecord(JSON.parse(line))
    if (record.sessionId !== sessionId || record.seq <= previousSeq)
      throw new SessionMigrationError("target_validation", "target identity or order is invalid")
    const base = {
      version: record.version,
      sessionId: record.sessionId,
      seq: record.seq,
      at: record.at,
      code: record.code,
      count: record.count,
      ...(record.pinned === true ? { pinned: true } : {}),
    }
    if ((await sha256Hex(JSON.stringify(base))) !== record.digest)
      throw new SessionMigrationError("target_validation", "target record digest is invalid")
    previousSeq = record.seq
    records.push(record)
  }
  return { records: Object.freeze(records), raw }
}

function validateSessionId(value: string): string {
  if (!SESSION_TOKEN.test(value))
    throw new SessionMigrationError("invalid_options", "invalid sessionId")
  return value
}

function requiredToken(value: unknown, name: string): string {
  if (typeof value !== "string" || !SESSION_TOKEN.test(value))
    throw new SessionMigrationError("invalid_record", `${name} must be a bounded token`)
  return value
}

function requiredCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    (!/^legacy\.[a-z0-9.-]+$/.test(value) && !KNOWN_EVENT_CODES.has(value))
  )
    throw new SessionMigrationError("invalid_record", "code is invalid")
  return value
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new SessionMigrationError("invalid_record", `${name} must be a non-negative integer`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"
}

function isWithin(parent: string, child: string): boolean {
  const prefix = parent.endsWith("/") ? parent : `${parent}/`
  return child.startsWith(prefix)
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SessionMigrationError("aborted", "migration was interrupted")
}

function randomToken(): string {
  return crypto.randomUUID().replaceAll("-", "")
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function canonicalRecord(record: SessionEvidenceRecord): string {
  return JSON.stringify({
    version: record.version,
    sessionId: record.sessionId,
    seq: record.seq,
    at: record.at,
    code: record.code,
    count: record.count,
    ...(record.pinned === true ? { pinned: true } : {}),
    digest: record.digest,
  })
}
