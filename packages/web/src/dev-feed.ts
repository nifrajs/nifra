/**
 * `@nifrajs/web/dev-feed` - what a running dev server saw, kept so the agent driving it can ask.
 *
 * Both dev servers (`./dev.ts`, `./vite.ts`) record into one {@link DevFeed}: every error with its
 * structured {@link Diagnostic} (failures a `_error` boundary rendered, backend 500s, build and guard
 * failures, browser errors, crashes), every console line, and every request. `nifra errors`,
 * `nifra logs` and `nifra inspect` (and their MCP tools) read it back over the dev server's own HTTP
 * surface, found through the discovery record this module also owns.
 *
 * Three properties hold for everything stored here:
 * - Redacted on the way in. Secret formats and non-public env values are scrubbed before an entry
 *   exists, so nothing unredacted is ever served, persisted, or handed to an agent.
 * - Correlated. An entry recorded while a request is in flight carries that request's id.
 * - Edit-aware. Every entry has a monotonic `seq` (query with `since`) and the `generation` it was last
 *   seen in; a file change bumps the generation, so an error recorded before the latest edit reads as
 *   `stale` instead of current.
 *
 * Dev-only by construction: no production entry imports this module.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { formatWithOptions, stripVTControlCharacters } from "node:util"
import {
  type BuildDiagnosticOptions,
  buildDiagnostic,
  type Diagnostic,
  type DiagnosticFrame,
} from "./diagnostic.ts"
import { createRedactor } from "./internal/secret-scan.ts"

/** Version of the HTTP + record contract between a dev server and the tools that read it. */
export const DEV_FEED_SCHEMA = 1

/** The dev server's agent-facing endpoints. All live under `/__nifra/`, which no route can produce. */
export const DEV_FEED_PATHS = Object.freeze({
  identity: "/__nifra/dev",
  errors: "/__nifra/errors",
  logs: "/__nifra/logs",
  requests: "/__nifra/requests",
  clientEvent: "/__nifra/client-event",
})

/** Request header carrying the agent token from the discovery record. */
export const DEV_TOKEN_HEADER = "x-nifra-dev-token"
/** Response header naming the request id every entry recorded during that request carries. */
export const DEV_REQUEST_ID_HEADER = "x-nifra-request-id"
/** Response header marking a body as dev-feed JSON (so a tool can tell it from an app route). */
export const DEV_FEED_HEADER = "x-nifra-dev-feed"

/** Discovery record and persisted log, relative to the project root. `.nifra/` is gitignored. */
export const DEV_SERVER_RECORD_FILE = ".nifra/dev-server.json"
export const DEV_SERVER_LOG_FILE = ".nifra/dev-server.log"

export type DevErrorCategory =
  /** A failure that escaped the app entirely; the dev overlay rendered it. */
  | "ssr"
  /** A loader, action or render failure an `_error` boundary (or a soft-nav 500) answered. */
  | "page"
  /** An unhandled backend route error (a bare 500). */
  | "api"
  /** A client bundle, leak-guard, transform or app-construction failure. */
  | "build"
  /** An uncaught error or rejection in a browser tab. */
  | "browser"
  /** A hydration mismatch reported by the browser. */
  | "hydration"
  /** The dev server process itself crashed. */
  | "process"

export const DEV_ERROR_CATEGORIES: readonly DevErrorCategory[] = [
  "ssr",
  "page",
  "api",
  "build",
  "browser",
  "hydration",
  "process",
]

export type DevEntrySource = "server" | "browser"
export type DevLogLevel = "debug" | "info" | "log" | "warn" | "error"
export const DEV_LOG_LEVELS: readonly DevLogLevel[] = ["debug", "info", "log", "warn", "error"]

/** Narrow a string to a {@link DevLogLevel}. */
export function isDevLogLevel(value: unknown): value is DevLogLevel {
  return DEV_LOG_LEVELS.some((level) => level === value)
}

/** Narrow a string to a {@link DevErrorCategory}. */
export function isDevErrorCategory(value: unknown): value is DevErrorCategory {
  return DEV_ERROR_CATEGORIES.some((category) => category === value)
}

export interface DevErrorEntry {
  /** Sequence number of the latest occurrence; query with `since` to see only newer entries. */
  readonly seq: number
  /** Stable across repeats of the same failure. */
  readonly id: string
  readonly category: DevErrorCategory
  readonly source: DevEntrySource
  readonly diagnostic: Diagnostic
  readonly count: number
  readonly firstAt: string
  readonly lastAt: string
  /** The file-change generation of the latest occurrence. */
  readonly generation: number
  /** True when a file changed after the latest occurrence: re-run the request to confirm it persists. */
  readonly stale: boolean
  readonly requestId?: string
  /** The route pattern, when a page loader/action/render failed. */
  readonly route?: string
  /** The page path a browser entry came from. */
  readonly page?: string
  /** Set when a later success cleared it (build errors). */
  readonly resolvedAt?: string
}

export interface DevLogEntry {
  readonly seq: number
  readonly at: string
  readonly level: DevLogLevel
  readonly source: DevEntrySource
  readonly message: string
  readonly requestId?: string
  readonly page?: string
}

export interface DevRequestTrace {
  readonly seq: number
  readonly requestId: string
  readonly method: string
  readonly path: string
  readonly at: string
  /** Undefined while the request has not produced its response yet. */
  readonly status?: number
  /** Until the response started (a streamed body keeps flowing after). */
  readonly durationMs?: number
  readonly bytes?: number
  readonly isr?: string
  readonly errorIds: readonly string[]
  readonly logCount: number
}

export interface DevErrorsQuery {
  readonly since?: number | undefined
  readonly categories?: readonly DevErrorCategory[] | undefined
  /** Default true. */
  readonly includeStale?: boolean | undefined
  /** Default false. */
  readonly includeResolved?: boolean | undefined
  readonly requestId?: string | undefined
  readonly limit?: number | undefined
}

export interface DevLogsQuery {
  readonly since?: number | undefined
  readonly levels?: readonly DevLogLevel[] | undefined
  readonly source?: DevEntrySource | undefined
  readonly requestId?: string | undefined
  /** Case-insensitive substring. */
  readonly grep?: string | undefined
  readonly limit?: number | undefined
}

export interface DevRequestsQuery {
  readonly since?: number | undefined
  /** Path prefix. */
  readonly path?: string | undefined
  readonly requestId?: string | undefined
  readonly limit?: number | undefined
}

interface PageInfo {
  /** Highest seq in the feed: pass it back as `since` to see only what happens next. */
  readonly cursor: number
  readonly generation: number
}
export interface DevErrorsResult extends PageInfo {
  readonly errors: readonly DevErrorEntry[]
}
export interface DevLogsResult extends PageInfo {
  readonly logs: readonly DevLogEntry[]
  /** Lines evicted from the ring since the server started. */
  readonly dropped: number
}
export interface DevRequestsResult extends PageInfo {
  readonly requests: readonly DevRequestTrace[]
}

export type DevPipeline = "bun" | "vite"

/** The identity a dev server reports at {@link DEV_FEED_PATHS.identity}. */
export interface DevServerIdentity {
  readonly schema: number
  readonly pid: number
  readonly port: number
  readonly pipeline: DevPipeline
  readonly root: string
  readonly startedAt: string
  readonly cursor: number
  readonly generation: number
  readonly counts: { readonly errors: number; readonly logs: number; readonly requests: number }
}

export interface ErrorMeta {
  readonly category: DevErrorCategory
  readonly source?: DevEntrySource | undefined
  readonly requestId?: string | undefined
  readonly route?: string | undefined
  readonly page?: string | undefined
  readonly request?: { readonly method: string; readonly url: string } | undefined
}

export interface LogMeta {
  readonly source?: DevEntrySource | undefined
  readonly requestId?: string | undefined
  readonly page?: string | undefined
}

export interface DevFeedLimits {
  readonly errors: number
  readonly logs: number
  readonly logBytes: number
  readonly requests: number
  readonly message: number
  readonly stack: number
}

export const DEFAULT_DEV_FEED_LIMITS: DevFeedLimits = Object.freeze({
  errors: 100,
  logs: 2000,
  logBytes: 1024 * 1024,
  requests: 500,
  message: 8 * 1024,
  stack: 16 * 1024,
})

export interface DevFeedOptions {
  readonly root: string
  readonly publicEnvPrefix?: string | undefined
  /** The environment whose non-public values are redacted (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** Append redacted entries to {@link DEV_SERVER_LOG_FILE} (default true). */
  readonly persist?: boolean | undefined
  /** Whether a file's source may appear in a codeframe. Dev servers pass the zone check. */
  readonly showSource?: ((file: string) => boolean) | undefined
  readonly limits?: Partial<DevFeedLimits> | undefined
}

export interface DevFeed {
  /** Identifies this feed's requests to the process-wide capture. */
  readonly id: string
  readonly root: string
  readonly generation: number
  readonly cursor: number
  recordError(error: unknown, meta: ErrorMeta): DevErrorEntry
  recordDiagnostic(diagnostic: Diagnostic, meta: ErrorMeta): DevErrorEntry
  recordLog(level: DevLogLevel, message: string, meta?: LogMeta): void
  startRequest(requestId: string, method: string, path: string): void
  finishRequest(
    requestId: string,
    response: {
      readonly status: number
      readonly bytes?: number | undefined
      readonly isr?: string | undefined
    },
    durationMs: number,
  ): void
  /** A watched file changed: everything recorded so far becomes stale. */
  markChange(): void
  /** A later success cleared every open error of `category`. */
  resolve(category: DevErrorCategory): void
  errors(query?: DevErrorsQuery): DevErrorsResult
  logs(query?: DevLogsQuery): DevLogsResult
  requests(query?: DevRequestsQuery): DevRequestsResult
  counts(): DevServerIdentity["counts"]
  redact(text: string): string
  /** Flush persisted entries; the feed stays usable. */
  flush(): void
  /** Flush and stop persisting. */
  close(): void
}

type Writable<T> = { -readonly [K in keyof T]: T[K] }

// ---------------------------------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------------------------------

export interface DevRequestContext {
  readonly feedId: string
  readonly requestId: string
  readonly method: string
  readonly path: string
}

// One store per process: a second copy of this module (a dual install) must still see the request the
// first one started, or its log lines would land untagged.
const ALS_KEY = Symbol.for("nifra.devFeed.requestContext")
const requestContext: AsyncLocalStorage<DevRequestContext> = sharedRequestContext()

function sharedRequestContext(): AsyncLocalStorage<DevRequestContext> {
  const existing: unknown = Reflect.get(globalThis, ALS_KEY)
  if (existing instanceof AsyncLocalStorage) return existing
  const created = new AsyncLocalStorage<DevRequestContext>()
  Reflect.set(globalThis, ALS_KEY, created)
  return created
}

/** Run `fn` as the handling of one request: entries recorded inside it carry `ctx.requestId`. */
export function runWithDevRequest<T>(ctx: DevRequestContext, fn: () => T): T {
  return requestContext.run(ctx, fn)
}

/** The request being handled on this async path, if any. */
export function currentDevRequest(): DevRequestContext | undefined {
  return requestContext.getStore()
}

/** The request in flight on this async path, when it belongs to the feed `feedId`. */
function currentRequestFor(feedId: string): DevRequestContext | undefined {
  const ctx = requestContext.getStore()
  return ctx?.feedId === feedId ? ctx : undefined
}

// ---------------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------------

interface ErrorRecord {
  seq: number
  readonly id: string
  readonly category: DevErrorCategory
  readonly source: DevEntrySource
  diagnostic: Diagnostic
  count: number
  readonly firstAt: string
  lastAt: string
  generation: number
  requestId: string | undefined
  route: string | undefined
  page: string | undefined
  resolvedAt: string | undefined
}

interface TraceRecord {
  readonly seq: number
  readonly requestId: string
  readonly method: string
  readonly path: string
  readonly at: string
  status: number | undefined
  durationMs: number | undefined
  bytes: number | undefined
  isr: string | undefined
  readonly errorIds: string[]
  logCount: number
}

const nowIso = (): string => new Date().toISOString()

const clampLimit = (value: number | undefined, fallback: number, max: number): number =>
  value === undefined || !Number.isFinite(value) || value < 1
    ? fallback
    : Math.min(Math.floor(value), max)

/** FNV-1a: a stable short id for a failure fingerprint. Not a security boundary. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

const cap = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}... [${text.length - max} more chars]`

const firstLine = (text: string): string => {
  const end = text.indexOf("\n")
  return end === -1 ? text : text.slice(0, end)
}

function snapshotError(record: ErrorRecord, currentGeneration: number): DevErrorEntry {
  const entry: Writable<DevErrorEntry> = {
    seq: record.seq,
    id: record.id,
    category: record.category,
    source: record.source,
    diagnostic: record.diagnostic,
    count: record.count,
    firstAt: record.firstAt,
    lastAt: record.lastAt,
    generation: record.generation,
    stale: record.generation < currentGeneration,
  }
  if (record.requestId !== undefined) entry.requestId = record.requestId
  if (record.route !== undefined) entry.route = record.route
  if (record.page !== undefined) entry.page = record.page
  if (record.resolvedAt !== undefined) entry.resolvedAt = record.resolvedAt
  return entry
}

function snapshotTrace(trace: TraceRecord): DevRequestTrace {
  const entry: Writable<DevRequestTrace> = {
    seq: trace.seq,
    requestId: trace.requestId,
    method: trace.method,
    path: trace.path,
    at: trace.at,
    errorIds: [...trace.errorIds],
    logCount: trace.logCount,
  }
  if (trace.status !== undefined) entry.status = trace.status
  if (trace.durationMs !== undefined) entry.durationMs = trace.durationMs
  if (trace.bytes !== undefined) entry.bytes = trace.bytes
  if (trace.isr !== undefined) entry.isr = trace.isr
  return entry
}

function evictOldest<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done === true) return
    map.delete(oldest.value)
  }
}

let feedCounter = 0

/** Create the store a dev server records into. */
export function createDevFeed(options: DevFeedOptions): DevFeed {
  const limits: DevFeedLimits = { ...DEFAULT_DEV_FEED_LIMITS, ...options.limits }
  const root = options.root
  const redactText = createRedactor(options.env ?? process.env, options.publicEnvPrefix)
  const persist = options.persist === false ? undefined : createPersistence(root)
  feedCounter += 1
  const id = `feed${feedCounter}-${randomBytes(3).toString("hex")}`
  const errors = new Map<string, ErrorRecord>()
  const traces = new Map<string, TraceRecord>()
  let logs: DevLogEntry[] = []
  let logBytes = 0
  let dropped = 0
  let seq = 0
  let generation = 0

  const redactFrame = (frame: DiagnosticFrame): DiagnosticFrame => ({
    ...frame,
    raw: cap(redactText(frame.raw), 1024),
  })

  const redactDiagnostic = (diagnostic: Diagnostic): Diagnostic => {
    const redacted: Writable<Diagnostic> = {
      ...diagnostic,
      message: cap(redactText(diagnostic.message), limits.message),
      frames: diagnostic.frames.slice(0, 50).map(redactFrame),
    }
    if (diagnostic.request !== undefined) {
      redacted.request = {
        method: diagnostic.request.method,
        url: cap(redactText(diagnostic.request.url), 2048),
      }
    }
    if (diagnostic.codeframe !== undefined) {
      redacted.codeframe = {
        ...diagnostic.codeframe,
        lines: diagnostic.codeframe.lines.map((line) => ({
          ...line,
          text: cap(redactText(line.text), 400),
        })),
      }
    }
    return redacted
  }

  const recordDiagnostic = (raw: Diagnostic, meta: ErrorMeta): DevErrorEntry => {
    const diagnostic = redactDiagnostic(raw)
    const requestId = meta.requestId ?? currentRequestFor(id)?.requestId
    const top = diagnostic.frames.find((frame) => frame.file !== undefined)
    const fingerprint = [
      meta.category,
      diagnostic.code,
      diagnostic.name,
      firstLine(diagnostic.message).slice(0, 300),
      top === undefined ? "" : `${top.file}:${top.line}`,
    ].join("|")
    const key = `e_${fnv1a(fingerprint)}`
    const at = nowIso()
    seq += 1
    const existing = errors.get(key)
    const record: ErrorRecord = existing ?? {
      seq,
      id: key,
      category: meta.category,
      source: meta.source ?? "server",
      diagnostic,
      count: 0,
      firstAt: at,
      lastAt: at,
      generation,
      requestId: undefined,
      route: undefined,
      page: undefined,
      resolvedAt: undefined,
    }
    record.seq = seq
    record.diagnostic = diagnostic
    record.count += 1
    record.lastAt = at
    record.generation = generation
    record.resolvedAt = undefined
    if (requestId !== undefined) record.requestId = requestId
    if (meta.route !== undefined) record.route = meta.route
    if (meta.page !== undefined) record.page = meta.page
    // Re-insert: Map order is recency order, which eviction relies on.
    errors.delete(key)
    errors.set(key, record)
    evictOldest(errors, limits.errors)
    if (requestId !== undefined) {
      const trace = traces.get(requestId)
      if (trace !== undefined && !trace.errorIds.includes(key)) trace.errorIds.push(key)
    }
    const entry = snapshotError(record, generation)
    persist?.write({ t: "error", ...entry }, true)
    return entry
  }

  const recordLog = (level: DevLogLevel, message: string, meta: LogMeta = {}): void => {
    const text = cap(redactText(message), limits.message)
    if (text.length === 0) return
    const requestId = meta.requestId ?? currentRequestFor(id)?.requestId
    seq += 1
    const entry: Writable<DevLogEntry> = {
      seq,
      at: nowIso(),
      level,
      source: meta.source ?? "server",
      message: text,
    }
    if (requestId !== undefined) entry.requestId = requestId
    if (meta.page !== undefined) entry.page = meta.page
    logs.push(entry)
    logBytes += text.length
    if (logs.length > limits.logs || logBytes > limits.logBytes) {
      // Past the count cap, evict an extra tenth so a full ring does not re-slice on every line.
      const byCount =
        logs.length > limits.logs
          ? Math.min(logs.length - 1, logs.length - limits.logs + Math.floor(limits.logs / 10))
          : 0
      let cut = 0
      let freed = 0
      while (cut < logs.length - 1 && (cut < byCount || logBytes - freed > limits.logBytes)) {
        freed += logs[cut]?.message.length ?? 0
        cut += 1
      }
      logs = logs.slice(cut)
      logBytes -= freed
      dropped += cut
    }
    if (requestId !== undefined) {
      const trace = traces.get(requestId)
      if (trace !== undefined) trace.logCount += 1
    }
    persist?.write({ t: "log", ...entry }, level === "error")
  }

  return {
    id,
    root,
    get generation() {
      return generation
    },
    get cursor() {
      return seq
    },
    recordError(error, meta) {
      const diagnosticOptions: Writable<BuildDiagnosticOptions> = { root }
      if (meta.request !== undefined) diagnosticOptions.request = meta.request
      if (options.showSource !== undefined) diagnosticOptions.showSource = options.showSource
      return recordDiagnostic(buildDiagnostic(error, diagnosticOptions), meta)
    },
    recordDiagnostic,
    recordLog,
    startRequest(requestId, method, path) {
      seq += 1
      traces.set(requestId, {
        seq,
        requestId,
        method,
        path: cap(redactText(path), 2048),
        at: nowIso(),
        status: undefined,
        durationMs: undefined,
        bytes: undefined,
        isr: undefined,
        errorIds: [],
        logCount: 0,
      })
      evictOldest(traces, limits.requests)
    },
    finishRequest(requestId, response, durationMs) {
      const trace = traces.get(requestId)
      if (trace === undefined) return
      trace.status = response.status
      trace.durationMs = Math.round(durationMs * 100) / 100
      trace.bytes = response.bytes
      trace.isr = response.isr
    },
    markChange() {
      generation += 1
    },
    resolve(category) {
      const at = nowIso()
      for (const record of errors.values()) {
        if (record.category === category && record.resolvedAt === undefined) record.resolvedAt = at
      }
    },
    errors(query = {}) {
      const since = query.since ?? 0
      const selected: DevErrorEntry[] = []
      for (const record of errors.values()) {
        if (record.seq <= since) continue
        if (query.categories !== undefined && !query.categories.includes(record.category)) continue
        if (query.includeResolved !== true && record.resolvedAt !== undefined) continue
        if (query.includeStale === false && record.generation < generation) continue
        if (query.requestId !== undefined && record.requestId !== query.requestId) continue
        selected.push(snapshotError(record, generation))
      }
      const limit = clampLimit(query.limit, 50, limits.errors)
      return { errors: selected.slice(-limit), cursor: seq, generation }
    },
    logs(query = {}) {
      const since = query.since ?? 0
      const needle = query.grep?.toLowerCase()
      const selected = logs.filter(
        (entry) =>
          entry.seq > since &&
          (query.levels === undefined || query.levels.includes(entry.level)) &&
          (query.source === undefined || entry.source === query.source) &&
          (query.requestId === undefined || entry.requestId === query.requestId) &&
          (needle === undefined || entry.message.toLowerCase().includes(needle)),
      )
      const limit = clampLimit(query.limit, 200, limits.logs)
      return { logs: selected.slice(-limit), cursor: seq, generation, dropped }
    },
    requests(query = {}) {
      const since = query.since ?? 0
      const selected: DevRequestTrace[] = []
      for (const trace of traces.values()) {
        if (trace.seq <= since) continue
        if (query.path !== undefined && !trace.path.startsWith(query.path)) continue
        if (query.requestId !== undefined && trace.requestId !== query.requestId) continue
        selected.push(snapshotTrace(trace))
      }
      const limit = clampLimit(query.limit, 50, limits.requests)
      return { requests: selected.slice(-limit), cursor: seq, generation }
    },
    counts: () => ({ errors: errors.size, logs: logs.length, requests: traces.size }),
    redact: redactText,
    flush: () => persist?.flush(),
    close: () => persist?.close(),
  }
}

// ---------------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------------

const LOG_ROTATE_BYTES = 2 * 1024 * 1024
const LOG_FLUSH_MS = 250

interface Persistence {
  write(entry: Readonly<Record<string, unknown>>, sync: boolean): void
  flush(): void
  close(): void
}

/**
 * NDJSON on disk so a crashed dev server still leaves a record. Error-level writes are synchronous (the
 * line most worth keeping is the one written just before a crash); the rest is buffered briefly. One
 * rotation (`.1`) bounds the footprint. A write failure disables persistence rather than breaking dev.
 */
function createPersistence(root: string): Persistence {
  const path = join(root, DEV_SERVER_LOG_FILE)
  let buffer: string[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disabled = false
  try {
    mkdirSync(dirname(path), { recursive: true })
    size = existsSync(path) ? statSync(path).size : 0
  } catch {
    disabled = true
  }
  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (disabled || buffer.length === 0) return
    const chunk = buffer.join("")
    buffer = []
    try {
      if (size + chunk.length > LOG_ROTATE_BYTES) {
        renameSync(path, `${path}.1`)
        size = 0
      }
      appendFileSync(path, chunk)
      size += chunk.length
    } catch {
      disabled = true
    }
  }
  return {
    write(entry, sync) {
      if (disabled) return
      buffer.push(`${JSON.stringify(entry)}\n`)
      if (sync) flush()
      else if (timer === undefined) {
        timer = setTimeout(flush, LOG_FLUSH_MS)
        timer.unref?.()
      }
    },
    flush,
    close: () => {
      flush()
      disabled = true
    },
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function isPersistedError(value: unknown): value is DevErrorEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.seq === "number" &&
    isDevErrorCategory(value.category) &&
    isRecord(value.diagnostic)
  )
}

function isPersistedLog(value: unknown): value is DevLogEntry {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    typeof value.seq === "number" &&
    isDevLogLevel(value.level)
  )
}

/** The persisted record of a dev server that may no longer be running: newest last. */
export function readPersistedFeed(
  root: string,
  limit = 200,
): { readonly errors: DevErrorEntry[]; readonly logs: DevLogEntry[] } {
  const path = join(root, DEV_SERVER_LOG_FILE)
  const errors = new Map<string, DevErrorEntry>()
  const logs: DevLogEntry[] = []
  for (const file of [`${path}.1`, path]) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      if (line.length === 0) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(value)) continue
      const { t, ...entry } = value
      if (t === "error" && isPersistedError(entry)) {
        errors.delete(entry.id)
        errors.set(entry.id, entry)
      } else if (t === "log" && isPersistedLog(entry)) {
        logs.push(entry)
      }
    }
  }
  return { errors: [...errors.values()].slice(-limit), logs: logs.slice(-limit) }
}

/**
 * Record a dev server process that died, from the process that supervised it (`nifra dev` re-execs the
 * Bun pipeline and pipes the child's stderr). The child's own monitor never sees an unhandled rejection
 * on Bun, and a native crash print bypasses the console, so the supervisor's view of stderr is the
 * record that survives. Persisted only: there is no live server left to serve it.
 */
export function recordDevCrash(root: string, exitCode: number | null, stderrTail: string): void {
  const feed = createDevFeed({ root })
  const summary = `the dev server exited with code ${exitCode ?? "unknown"}`
  const error = new Error(summary)
  error.name = "DevServerExit"
  error.stack = `DevServerExit: ${summary}\n${stderrTail.slice(-DEFAULT_DEV_FEED_LIMITS.stack)}`
  feed.recordError(error, { category: "process" })
  feed.close()
}

// ---------------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------------

/** What a running dev server writes to {@link DEV_SERVER_RECORD_FILE} so tools can find it. */
export interface DevServerRecord {
  readonly schema: number
  readonly pid: number
  readonly port: number
  readonly url: string
  readonly pipeline: DevPipeline
  readonly root: string
  readonly startedAt: string
  /** Sent as {@link DEV_TOKEN_HEADER}. Only a reader of this file (mode 0600) can present it. */
  readonly token: string
}

/** A fresh 256-bit token. */
export function createDevToken(): string {
  return randomBytes(32).toString("base64url")
}

/** Write the record atomically (temp file + rename) and owner-only. */
export function writeDevServerRecord(root: string, record: DevServerRecord): void {
  const path = join(root, DEV_SERVER_RECORD_FILE)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

/** Remove the record only while it is still this server's: a newer server may have replaced it. */
export function removeDevServerRecord(root: string, token: string): void {
  if (readDevServerRecord(root)?.token !== token) return
  rmSync(join(root, DEV_SERVER_RECORD_FILE), { force: true })
}

const isPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 65536

function isDevServerRecord(value: unknown): value is DevServerRecord {
  return (
    isRecord(value) &&
    typeof value.schema === "number" &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    isPort(value.port) &&
    typeof value.url === "string" &&
    (value.pipeline === "bun" || value.pipeline === "vite") &&
    typeof value.root === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.token === "string" &&
    value.token.length >= 32
  )
}

/** The record at `root`, or undefined when absent or malformed. Says nothing about liveness. */
export function readDevServerRecord(root: string): DevServerRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(root, DEV_SERVER_RECORD_FILE), "utf8"))
  } catch {
    return undefined
  }
  return isDevServerRecord(value) ? value : undefined
}

/** Whether a process with `pid` exists (EPERM means it exists but is not ours). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

// ---------------------------------------------------------------------------------------------------
// Console + stream capture
// ---------------------------------------------------------------------------------------------------

export interface CaptureSink {
  /** The feed this sink records into; a line logged inside one of its requests reaches only it. */
  readonly feedId: string
  line(level: DevLogLevel, message: string, request: DevRequestContext | undefined): void
  /** A structured line from core's JSON logger (`{ level, message, ... }`). */
  structured?(entry: CoreLogEntry, request: DevRequestContext | undefined): void
}

export interface CoreLogEntry {
  readonly level: string
  readonly message: string
  readonly [field: string]: unknown
}

type ConsoleMethod = "debug" | "info" | "log" | "warn" | "error" | "trace"
const CONSOLE_METHODS: readonly ConsoleMethod[] = ["debug", "info", "log", "warn", "error", "trace"]
const CONSOLE_LEVELS: Readonly<Record<ConsoleMethod, DevLogLevel>> = {
  debug: "debug",
  info: "info",
  log: "log",
  warn: "warn",
  error: "error",
  trace: "log",
}

type ConsoleFn = (...args: unknown[]) => void
type WriteFn = (chunk: unknown, ...rest: unknown[]) => boolean

interface CaptureState {
  readonly sinks: Set<CaptureSink>
  /** Inside a patched console call: a stream write it makes (Node) is the same line, not a new one. */
  depth: number
  restore: () => void
}

// Structural, not `instanceof`: a second copy of this module must join the first one's patch rather
// than layer another on top and capture every line twice.
const isCaptureState = (value: unknown): value is CaptureState =>
  isRecord(value) &&
  value.sinks instanceof Set &&
  typeof value.depth === "number" &&
  typeof value.restore === "function"

const CAPTURE_KEY = Symbol.for("nifra.devFeed.capture")
const MAX_PARTIAL_LINE = 16 * 1024

/** Format console arguments the way the console itself would, without color. */
export function formatConsoleArgs(args: readonly unknown[]): string {
  try {
    return formatWithOptions(
      { colors: false, depth: 4, breakLength: Number.POSITIVE_INFINITY, maxArrayLength: 50 },
      ...args,
    )
  } catch {
    return args.map((arg) => String(arg)).join(" ")
  }
}

const isCoreLogEntry = (value: unknown): value is CoreLogEntry =>
  isRecord(value) && typeof value.level === "string" && typeof value.message === "string"

/** Parse a line core's default JSON logger wrote, or undefined for anything else. */
export function parseCoreLogLine(line: string): CoreLogEntry | undefined {
  if (!line.startsWith("{") || !line.endsWith("}")) return undefined
  try {
    const value: unknown = JSON.parse(line)
    return isCoreLogEntry(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** The thrown error core's `unhandled request error` log line describes, rebuilt for a Diagnostic. */
export function errorFromCoreLog(entry: CoreLogEntry): Error | undefined {
  if (entry.message !== "unhandled request error") return undefined
  const name = typeof entry.name === "string" ? entry.name : "Error"
  const detail = typeof entry.detail === "string" ? entry.detail : name
  const error = new Error(detail)
  error.name = name
  error.stack = typeof entry.stack === "string" ? entry.stack : `${name}: ${detail}`
  return error
}

/**
 * Tee the process's console and stdout/stderr into `sink`, leaving the real output untouched. Global
 * and reference-counted: several dev servers (tests start many) share one patch, and the originals come
 * back when the last sink detaches. Returns the detach function.
 */
export function installCapture(sink: CaptureSink): () => void {
  const existing: unknown = Reflect.get(globalThis, CAPTURE_KEY)
  const state = isCaptureState(existing) ? existing : patchProcess()
  Reflect.set(globalThis, CAPTURE_KEY, state)
  state.sinks.add(sink)
  let attached = true
  return () => {
    if (!attached) return
    attached = false
    state.sinks.delete(sink)
    if (state.sinks.size === 0 && Reflect.get(globalThis, CAPTURE_KEY) === state) {
      state.restore()
      Reflect.deleteProperty(globalThis, CAPTURE_KEY)
    }
  }
}

function patchProcess(): CaptureState {
  const state: CaptureState = { sinks: new Set(), depth: 0, restore: () => {} }
  const dispatch = (level: DevLogLevel, message: string, structured?: CoreLogEntry): void => {
    const request = requestContext.getStore()
    for (const sink of state.sinks) {
      if (request !== undefined && request.feedId !== sink.feedId) continue
      try {
        if (structured !== undefined && sink.structured !== undefined) {
          sink.structured(structured, request)
        } else sink.line(level, message, request)
      } catch {
        // A sink must never break the console it observes.
      }
    }
  }

  const consoleOriginals = new Map<ConsoleMethod, { original: ConsoleFn; patched: ConsoleFn }>()
  for (const method of CONSOLE_METHODS) {
    const original: ConsoleFn = console[method]
    const patched: ConsoleFn = function (this: unknown, ...args: unknown[]): void {
      state.depth += 1
      try {
        original.apply(this, args)
      } finally {
        state.depth -= 1
      }
      dispatch(CONSOLE_LEVELS[method], stripVTControlCharacters(formatConsoleArgs(args)))
    }
    consoleOriginals.set(method, { original, patched })
    console[method] = patched
  }

  const streamOriginals: Array<{ stream: object; original: unknown; patched: WriteFn }> = []
  for (const [stream, level] of [
    [process.stdout, "log"],
    [process.stderr, "error"],
  ] as const) {
    const original: unknown = Reflect.get(stream, "write")
    if (typeof original !== "function") continue
    let partial = ""
    const patched: WriteFn = function (this: unknown, chunk, ...rest) {
      if (state.depth === 0) {
        partial +=
          typeof chunk === "string"
            ? chunk
            : chunk instanceof Uint8Array
              ? new TextDecoder().decode(chunk)
              : ""
        let newline = partial.indexOf("\n")
        while (newline !== -1) {
          const line = stripVTControlCharacters(partial.slice(0, newline)).trimEnd()
          partial = partial.slice(newline + 1)
          if (line.length > 0) {
            const structured = parseCoreLogLine(line)
            dispatch(
              structured !== undefined && isDevLogLevel(structured.level)
                ? structured.level
                : level,
              line,
              structured,
            )
          }
          newline = partial.indexOf("\n")
        }
        if (partial.length > MAX_PARTIAL_LINE) {
          dispatch(level, stripVTControlCharacters(partial))
          partial = ""
        }
      }
      return Reflect.apply(original, this ?? stream, [chunk, ...rest]) !== false
    }
    streamOriginals.push({ stream, original, patched })
    Reflect.set(stream, "write", patched)
  }

  state.restore = () => {
    for (const [method, { original, patched }] of consoleOriginals) {
      // Only undo our own patch: a later patch layered on top stays, still forwarding to ours.
      if (console[method] === patched) console[method] = original
    }
    for (const { stream, original, patched } of streamOriginals) {
      if (Reflect.get(stream, "write") === patched) Reflect.set(stream, "write", original)
    }
  }
  return state
}

const structuredText = (entry: CoreLogEntry): string => {
  const { level: _level, message, time: _time, ...fields } = entry
  return Object.keys(fields).length === 0 ? message : `${message} ${JSON.stringify(fields)}`
}

/**
 * Record the process's console and stream output into `feed`: every line as a log entry, and core's
 * `unhandled request error` line additionally as an `api` error with a full Diagnostic. The one sink
 * both dev servers and `nifra_run` use. Returns the detach function.
 */
export function captureInto(feed: DevFeed): () => void {
  return installCapture({
    feedId: feed.id,
    line: (level, message, request) =>
      feed.recordLog(level, message, { requestId: request?.requestId }),
    structured: (entry, request) => {
      const level = isDevLogLevel(entry.level) ? entry.level : "log"
      feed.recordLog(level, structuredText(entry), { requestId: request?.requestId })
      const error = errorFromCoreLog(entry)
      if (error === undefined) return
      const method = typeof entry.method === "string" ? entry.method : request?.method
      const path = typeof entry.path === "string" ? entry.path : request?.path
      feed.recordError(error, {
        category: "api",
        requestId: request?.requestId,
        request: method !== undefined && path !== undefined ? { method, url: path } : undefined,
      })
    },
  })
}
