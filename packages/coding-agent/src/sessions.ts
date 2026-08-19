import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export interface SessionLogEntry {
  readonly version: 1
  readonly sessionId: string
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly payload?: unknown
  readonly pinned?: boolean
}

export interface SessionStore {
  append(
    sessionId: string,
    type: string,
    payload?: unknown,
    options?: { readonly pinned?: boolean },
  ): Promise<SessionLogEntry>
  read(sessionId: string): Promise<readonly SessionLogEntry[]>
  checkpoint(sessionId: string, payload: unknown): Promise<void>
  fork(sessionId: string, targetSessionId?: string): Promise<string>
}

export interface FileSessionStoreOptions {
  readonly root: string
  readonly maxEntryBytes?: number
}

/**
 * Small append-only JSONL store. It stores redacted, bounded event evidence rather than raw model
 * transcripts, so session recovery is useful without turning the agent into a memory sink.
 */
export class FileSessionStore implements SessionStore {
  private readonly root: string
  private readonly maxEntryBytes: number
  private readonly sequences = new Map<string, number>()

  constructor(options: FileSessionStoreOptions) {
    this.root = options.root
    this.maxEntryBytes = options.maxEntryBytes ?? 256 * 1024
    if (!Number.isSafeInteger(this.maxEntryBytes) || this.maxEntryBytes < 1024)
      throw new RangeError("session store: maxEntryBytes must be at least 1024")
  }

  async append(
    sessionId: string,
    type: string,
    payload?: unknown,
    options: { readonly pinned?: boolean } = {},
  ): Promise<SessionLogEntry> {
    validateToken(sessionId, "sessionId")
    if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(type))
      throw new TypeError("session store: invalid event type")
    await mkdir(this.root, { recursive: true })
    const nextSeq = await this.nextSequence(sessionId)
    const entry: SessionLogEntry = Object.freeze({
      version: 1,
      sessionId,
      seq: nextSeq,
      at: Date.now(),
      type,
      ...(payload === undefined
        ? {}
        : { payload: boundValue(redactValue(payload), this.maxEntryBytes) }),
      ...(options.pinned === true ? { pinned: true } : {}),
    })
    const line = JSON.stringify(entry)
    if (Buffer.byteLength(line, "utf8") > this.maxEntryBytes)
      throw new RangeError("session store: event exceeds maxEntryBytes")
    await appendFile(this.pathFor(sessionId), `${line}\n`, "utf8")
    this.sequences.set(sessionId, nextSeq)
    return entry
  }

  async read(sessionId: string): Promise<readonly SessionLogEntry[]> {
    validateToken(sessionId, "sessionId")
    try {
      const text = await readFile(this.pathFor(sessionId), "utf8")
      const entries: SessionLogEntry[] = []
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue
        const value: unknown = JSON.parse(line)
        if (isSessionLogEntry(value, sessionId)) entries.push(Object.freeze(value))
      }
      const last = entries.at(-1)?.seq
      if (last !== undefined) this.sequences.set(sessionId, last)
      return Object.freeze(entries)
    } catch (error) {
      if (isNotFound(error)) return Object.freeze([])
      throw error
    }
  }

  async checkpoint(sessionId: string, payload: unknown): Promise<void> {
    validateToken(sessionId, "sessionId")
    const target = join(this.root, `${sessionId}.checkpoint.json`)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await mkdir(dirname(target), { recursive: true })
    const content = JSON.stringify({
      version: 1,
      sessionId,
      at: Date.now(),
      payload: boundValue(redactValue(payload), this.maxEntryBytes),
    })
    await writeFile(temporary, content, "utf8")
    await rename(temporary, target)
  }

  async fork(
    sessionId: string,
    targetSessionId = `${sessionId}:fork:${Date.now().toString(36)}`,
  ): Promise<string> {
    validateToken(sessionId, "sessionId")
    validateToken(targetSessionId, "targetSessionId")
    const entries = await this.read(sessionId)
    await mkdir(this.root, { recursive: true })
    const target = this.pathFor(targetSessionId)
    const lines = entries.map((entry, index) =>
      JSON.stringify({ ...entry, sessionId: targetSessionId, seq: index }),
    )
    await writeFile(target, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8")
    this.sequences.set(targetSessionId, Math.max(0, lines.length - 1))
    return targetSessionId
  }

  private pathFor(sessionId: string): string {
    return join(this.root, `${sessionId}.jsonl`)
  }

  private async nextSequence(sessionId: string): Promise<number> {
    const cached = this.sequences.get(sessionId)
    if (cached !== undefined) return cached + 1
    const entries = await this.read(sessionId)
    return (entries.at(-1)?.seq ?? -1) + 1
  }
}

export interface ContextRecord {
  readonly kind: string
  readonly content: string
  readonly pinned?: boolean
}

export interface CompactionReport {
  readonly before: number
  readonly after: number
  readonly removed: number
  readonly reason: "manual" | "threshold" | "overflow" | "workflow"
}

export interface ContextWindowOptions {
  readonly maxTokens?: number
  readonly keepRecent?: number
  readonly maxSummaryChars?: number
  /** Optional extension-owned summary function. It cannot alter authoritative records. */
  readonly summarize?: (records: readonly ContextRecord[], maxChars: number) => string
}

/** In-memory prompt window with automatic, deterministic compaction and a hard size ceiling. */
export class ContextWindow {
  private readonly maxTokens: number
  private readonly keepRecent: number
  private readonly maxSummaryChars: number
  private readonly summarizeRecord: (records: readonly ContextRecord[], maxChars: number) => string
  private records: ContextRecord[] = []

  constructor(options: ContextWindowOptions = {}) {
    this.maxTokens = options.maxTokens ?? 32_000
    this.keepRecent = options.keepRecent ?? 24
    this.maxSummaryChars = options.maxSummaryChars ?? 4_096
    this.summarizeRecord = options.summarize ?? summarize
    if (!Number.isSafeInteger(this.maxTokens) || this.maxTokens < 256)
      throw new RangeError("context window: maxTokens must be at least 256")
    if (!Number.isSafeInteger(this.keepRecent) || this.keepRecent < 1)
      throw new RangeError("context window: keepRecent must be positive")
  }

  get tokens(): number {
    return estimateTokens(this.records)
  }

  get size(): number {
    return this.records.length
  }

  snapshot(): readonly ContextRecord[] {
    return Object.freeze(this.records.map((record) => Object.freeze({ ...record })))
  }

  /** Restore bounded prompt context from persisted evidence without bypassing compaction rules. */
  restore(records: readonly ContextRecord[]): void {
    this.records = []
    for (const record of records.slice(-Math.max(this.keepRecent * 8, 256))) this.append(record)
  }

  append(record: ContextRecord): CompactionReport | undefined {
    this.records.push({
      kind: record.kind,
      content: record.content.slice(0, this.maxSummaryChars),
      ...(record.pinned === true ? { pinned: true } : {}),
    })
    if (this.tokens <= this.maxTokens) return undefined
    return this.compact("threshold")
  }

  compact(reason: CompactionReport["reason"] = "manual"): CompactionReport {
    const before = this.tokens
    if (this.records.length <= this.keepRecent) return { before, after: before, removed: 0, reason }
    // A compacted summary is replaceable context, not authoritative evidence. Keeping old pinned
    // summaries in `protectedRecords` would make every threshold compaction grow the live window.
    const protectedRecords = this.records.filter(
      (record) =>
        record.kind !== "memory.summary" &&
        (record.pinned === true || isAuthoritative(record.kind)),
    )
    const recent = this.records.slice(-this.keepRecent)
    const retained = new Set([...protectedRecords, ...recent])
    const omitted = this.records.filter((record) => !retained.has(record))
    if (omitted.length === 0) return { before, after: before, removed: 0, reason }
    const summary = this.summarizeRecord(omitted, this.maxSummaryChars).slice(
      0,
      this.maxSummaryChars,
    )
    this.records = [
      ...protectedRecords,
      { kind: "memory.summary", content: summary, pinned: true },
      ...recent.filter(
        (record) => record.kind !== "memory.summary" && !protectedRecords.includes(record),
      ),
    ]
    const after = this.tokens
    return { before, after, removed: omitted.length, reason }
  }
}

function validateToken(value: string, name: string): void {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(value))
    throw new TypeError(`session store: ${name} must be a bounded token`)
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"
}

function isSessionLogEntry(value: unknown, sessionId: string): value is SessionLogEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.version === 1 &&
    record.sessionId === sessionId &&
    typeof record.seq === "number" &&
    Number.isSafeInteger(record.seq) &&
    typeof record.at === "number" &&
    typeof record.type === "string"
  )
}

function redactValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 5) return "[depth-limited]"
  if (/(?:secret|token|password|passwd|authorization|api[-_]?key|private[-_]?key)/i.test(key))
    return "[redacted]"
  if (typeof value === "string")
    return value.length > 16_384 ? `${value.slice(0, 16_384)}…[truncated]` : value
  if (Array.isArray(value))
    return value.slice(0, 256).map((item) => redactValue(item, "", depth + 1))
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value).slice(0, 256))
      result[childKey] = redactValue(childValue, childKey, depth + 1)
    return result
  }
  return value
}

function boundValue(value: unknown, maxBytes: number): unknown {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return value
  return "[payload-truncated]"
}

function estimateTokens(records: readonly ContextRecord[]): number {
  return Math.ceil(
    records.reduce((total, record) => total + record.kind.length + record.content.length, 0) / 4,
  )
}

function isAuthoritative(kind: string): boolean {
  return (
    kind.startsWith("approval") || kind.startsWith("verification") || kind === "session.checkpoint"
  )
}

function summarize(records: readonly ContextRecord[], maxChars: number): string {
  const lines = [`Compacted ${records.length} earlier context entries.`]
  for (const record of records.slice(-32)) {
    const line = `- ${record.kind}: ${record.content.replace(/\s+/g, " ").slice(0, 180)}`
    if (lines.join("\n").length + line.length + 1 > maxChars) break
    lines.push(line)
  }
  return lines.join("\n")
}
