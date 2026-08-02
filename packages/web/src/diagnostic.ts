/**
 * The structured diagnostic that every nifra failure resolves to - the single source both the human
 * dev overlay ([dev-error.ts]) and the agent-facing surfaces (`/__nifra/last-error`, `nifra_explain`)
 * render from. A stack trace is a wall of text; a `Diagnostic` is queryable: a stable `code`, the top
 * USER frame (file/line/column), a source codeframe around it, and - when the failure is one nifra
 * recognises - a plain-language `cause` + `fix` + docs anchor.
 *
 * This is the "AI-native" half of error reporting: the same object a person reads in the overlay is the
 * JSON an agent reads to apply the fix, so neither has to scrape the other's format.
 *
 * Pure + DOM-free by construction (it only parses strings and reads source text through an injected
 * reader), so it lives in the root typecheck program and is unit-testable without a dev server or disk.
 */
import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

/** Shared endpoint name used by both dev pipelines and the agent-facing MCP tools. */
export const LAST_ERROR_PATH = "/__nifra/last-error"

/** One parsed stack frame. `file`/`line`/`column` are present only when the frame could be located. */
export interface DiagnosticFrame {
  readonly raw: string
  readonly file?: string
  readonly line?: number
  readonly column?: number
}

/** A source window around the offending line. `caret` marks the exact line the top frame points at. */
export interface Codeframe {
  readonly file: string
  readonly line: number
  readonly column?: number | undefined
  readonly lines: ReadonlyArray<{
    readonly number: number
    readonly text: string
    readonly caret: boolean
  }>
}

/** The structured failure. Serialisable as-is to JSON for the agent surfaces. */
export interface Diagnostic {
  /** Stable, greppable identifier, e.g. `NIFRA_SERVER_ONLY_IN_CLIENT`. `NIFRA_UNHANDLED` when unrecognised. */
  readonly code: string
  readonly name: string
  readonly message: string
  readonly request?: { readonly method: string; readonly url: string } | undefined
  readonly frames: readonly DiagnosticFrame[]
  readonly codeframe?: Codeframe | undefined
  /** Plain-language "why this happened", when the failure is recognised. */
  readonly cause?: string | undefined
  /** Plain-language "do this", when the failure is recognised. */
  readonly fix?: string | undefined
  /** Docs section anchor for the code, e.g. `errors#server-only-in-client`. */
  readonly docsAnchor?: string | undefined
}

/** Reads a source file's text, or returns undefined if it cannot (missing, binary, permission). */
export type SourceReader = (file: string) => string | undefined

const defaultReader: SourceReader = (file) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

// Turns a raw frame path into an absolute filesystem path, or undefined if it isn't one. Handles the
// `file://` URL form Vite/Node emit and strips the `?v=hash` / `#` suffixes a bundler appends.
function cleanFramePath(path: string): string | undefined {
  let p = path.trim()
  if (p.startsWith("file://")) {
    try {
      p = decodeURIComponent(new URL(p).pathname)
    } catch {
      return undefined
    }
  }
  // Strip the `?v=hash` / `#` suffix without a `.*` regex (ReDoS-safe): cut at the first `?` or `#`.
  const cut = p.search(/[?#]/)
  if (cut !== -1) p = p.slice(0, cut)
  const isAbsolute = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)
  return isAbsolute ? p : undefined
}

/**
 * Parse a V8/Node stack into structured frames. Handles the `at fn (path:line:col)`, bare
 * `at path:line:col`, and `at async fn (...)` shapes; a frame that doesn't match keeps its raw text
 * with no location (so nothing is silently dropped).
 */
export function parseFrames(stack: string): DiagnosticFrame[] {
  const frames: DiagnosticFrame[] = []
  for (const line of stack.split("\n")) {
    const raw = line.trim()
    if (!/^at\s/.test(raw)) continue
    // Prefer the parenthesised location; fall back to a trailing `path:line:col`.
    const paren = raw.match(/\(([^()]+):(\d+):(\d+)\)\s*$/)
    const bare = raw.match(/^at\s+(?:async\s+)?(\S.*):(\d+):(\d+)\s*$/)
    const m = paren ?? bare
    if (!m) {
      frames.push({ raw })
      continue
    }
    const file = cleanFramePath(m[1] as string)
    frames.push(
      file === undefined ? { raw } : { raw, file, line: Number(m[2]), column: Number(m[3]) },
    )
  }
  return frames
}

/** Frames inside dependencies or the runtime are noise for a first look; the user's own code is the signal. */
function isUserFrame(file: string, root: string | undefined): boolean {
  if (file.includes("/node_modules/") || file.includes("\\node_modules\\")) return false
  if (file.startsWith("node:")) return false
  if (root !== undefined) {
    // A string prefix is not a path boundary (`/app-evil` starts with `/app`) and leaves `..` and
    // symlink escapes unresolved. Resolve lexically first, then realpath existing paths so a codeframe
    // can never read a source file outside the project root merely because a stack frame was crafted.
    const rootPath = canonicalPath(root)
    const framePath = canonicalPath(file)
    const rel = relative(rootPath, framePath)
    if (rel === ".." || rel.startsWith(`..${sepForPath(rel)}`) || isAbsolute(rel)) return false
  }
  return true
}

function sepForPath(path: string): string {
  return path.includes("\\") ? "\\" : "/"
}

function canonicalPath(path: string): string {
  const lexical = resolve(path)
  try {
    return realpathSync.native(lexical)
  } catch {
    return lexical
  }
}

/** The first frame that points at the user's own source - what the codeframe should show. */
export function topUserFrame(
  frames: readonly DiagnosticFrame[],
  root: string | undefined,
): DiagnosticFrame | undefined {
  return frames.find((f) => f.file !== undefined && isUserFrame(f.file, root))
}

/**
 * Build a source codeframe: `radius` lines either side of `line`, each tagged with its 1-based number
 * and whether it is the offending line. Returns undefined if the source can't be read or the line is
 * out of range - a diagnostic without a codeframe is still useful, so this never throws.
 */
export function buildCodeframe(
  file: string,
  line: number,
  column: number | undefined,
  read: SourceReader = defaultReader,
  radius = 3,
): Codeframe | undefined {
  const source = read(file)
  if (source === undefined) return undefined
  const all = source.split("\n")
  if (line < 1 || line > all.length) return undefined
  const start = Math.max(1, line - radius)
  const end = Math.min(all.length, line + radius)
  const lines: Array<{ number: number; text: string; caret: boolean }> = []
  for (let n = start; n <= end; n++) {
    lines.push({ number: n, text: all[n - 1] ?? "", caret: n === line })
  }
  return { file, line, column, lines }
}

/** A recognised failure shape: a stable code plus the plain-language cause/fix/anchor to attach. */
interface CatalogEntry {
  readonly code: string
  readonly match: (name: string, message: string) => boolean
  readonly cause: string
  readonly fix: string
  readonly docsAnchor: string
}

/**
 * The recognised-failure catalog. Seeded with the highest-signal nifra failures; extend it as new
 * classes of error earn a stable code. Order matters only in that the first match wins.
 */
export const DIAGNOSTIC_CATALOG: readonly CatalogEntry[] = [
  {
    code: "NIFRA_SERVER_ONLY_IN_CLIENT",
    match: (_n, m) => m.includes("server-only module(s) in the client bundle"),
    cause:
      "A module marked server-only was reachable from a client entry, so it would ship to the browser.",
    fix: "Follow the import chain in the message and move the server-only use behind a loader/action or a `*.server.ts` boundary, so it never enters a client component.",
    docsAnchor: "errors#server-only-in-client",
  },
  {
    code: "NIFRA_NODE_BUILTIN_IN_CLIENT",
    match: (_n, m) => m.includes("Node built-in(s) in the client bundle"),
    cause: "A `node:` built-in was reached from a client entry; it has no browser implementation.",
    fix: "Move the code using the built-in to the server (loader/action or `*.server.ts`); the message lists the import chain that pulled it in.",
    docsAnchor: "errors#node-builtin-in-client",
  },
  {
    code: "NIFRA_SCHEMA_PARSE",
    match: (n, m) =>
      n === "SchemaError" ||
      /failed to (parse|validate)|invalid_type|expected .* received/i.test(m),
    cause: "Data crossing a boundary did not match its declared schema.",
    fix: "Check the value against the schema at the failing boundary (loader input, search params, or request body); parse-don't-cast means the shape must match exactly.",
    docsAnchor: "errors#schema-parse",
  },
]

/** Classify an error name+message against the catalog; falls back to the generic unhandled code. */
export function classify(
  name: string,
  message: string,
): {
  code: string
  cause?: string
  fix?: string
  docsAnchor?: string
} {
  const hit = DIAGNOSTIC_CATALOG.find((e) => e.match(name, message))
  if (hit === undefined) return { code: "NIFRA_UNHANDLED" }
  return { code: hit.code, cause: hit.cause, fix: hit.fix, docsAnchor: hit.docsAnchor }
}

/** Split an Error's `stack` into its leading message block and its frame lines. */
function messageAndStack(err: Error): { message: string; stack: string } {
  const stack = err.stack ?? `${err.name}: ${err.message}`
  const lines = stack.split("\n")
  const firstFrame = lines.findIndex((l) => /^\s*at\s/.test(l))
  if (firstFrame === -1) return { message: err.message || stack.trim(), stack: "" }
  return {
    message: lines.slice(0, firstFrame).join("\n").trim(),
    stack: lines.slice(firstFrame).join("\n"),
  }
}

export interface BuildDiagnosticOptions {
  readonly request?: { readonly method: string; readonly url: string }
  /** Project root; frames outside it are treated as non-user. Defaults to `process.cwd()`. */
  readonly root?: string
  /** Injectable source reader (tests pass a fake; production reads the filesystem). */
  readonly read?: SourceReader
}

/**
 * Resolve any thrown value into a `Diagnostic`: parse the (already source-mapped) stack, locate the top
 * user frame, attach a codeframe, and classify the failure for a cause/fix. The caller is responsible
 * for running Vite's `ssrFixStacktrace` first so the frames point at real source.
 */
export function buildDiagnostic(err: unknown, options: BuildDiagnosticOptions = {}): Diagnostic {
  const error = err instanceof Error ? err : new Error(String(err))
  const root = options.root ?? safeCwd()
  const { message } = messageAndStack(error)
  const frames = parseFrames(error.stack ?? "")
  const top = topUserFrame(frames, root)
  const codeframe =
    top?.file !== undefined && top.line !== undefined
      ? buildCodeframe(canonicalPath(top.file), top.line, top.column, options.read)
      : undefined
  const { code, cause, fix, docsAnchor } = classify(error.name || "Error", message)
  return {
    code,
    name: error.name || "Error",
    message,
    request: options.request,
    frames,
    codeframe,
    cause,
    fix,
    docsAnchor,
  }
}

function safeCwd(): string | undefined {
  try {
    return process.cwd()
  } catch {
    return undefined
  }
}
