import { type HeadTailOutput, readHeadTail } from "./mcp-io.ts"
import { mcpProjectPathError, resolveMcpProjectPath } from "./mcp-path.ts"

export interface TestToolArgs {
  readonly pattern?: unknown
  readonly timeoutMs?: unknown
}

export interface TestSummary {
  readonly passed?: number
  readonly failed?: number
  readonly skipped?: number
  readonly expectations?: number
  readonly files?: number
}

export interface TestToolResult {
  readonly ok: boolean
  readonly command: readonly string[]
  readonly durationMs: number
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly cancelled?: boolean
  readonly summary: TestSummary
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const HEAD_CHARS = 4_000
const TAIL_CHARS = 8_000
const MAX_OUTPUT_CHARS = HEAD_CHARS + TAIL_CHARS

function normalizePattern(value: unknown, root: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Error("pattern must be a string")
  const pattern = value.trim()
  if (pattern === "") return undefined
  if (pattern.length > 500) throw new Error("pattern is too long")
  if (pattern.includes("\0")) throw new Error("pattern contains a NUL byte")
  // It is passed as argv, not a shell string, but blocking flags keeps the MCP tool's contract simple:
  // `pattern` narrows test files; it is not a remote flag injection surface.
  if (pattern.startsWith("-"))
    throw new Error("pattern must be a file/path pattern, not a CLI flag")
  // `bun test` runs any `./`, `../` or absolute path it is given, so a pattern stays inside the project.
  if (resolveMcpProjectPath(root, pattern) === null)
    throw new Error(mcpProjectPathError("pattern", pattern))
  return pattern
}

function normalizeTimeout(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("timeoutMs must be a finite number")
  }
  return Math.min(Math.max(Math.trunc(value), 1_000), MAX_TIMEOUT_MS)
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g")

// A UTF-8 character is at most four bytes, so these hold every character the result can show.
const HEAD_BYTES = HEAD_CHARS * 4
const TAIL_BYTES = TAIL_CHARS * 4

function clean(output: HeadTailOutput): string {
  const strip = (text: string): string => text.replace(ANSI, "")
  if (output.droppedBytes > 0)
    return `${strip(output.head).slice(0, HEAD_CHARS)}\n…(trimmed more than ${output.droppedBytes} bytes)…\n${strip(output.tail).slice(-TAIL_CHARS)}`
  const stripped = strip(output.head + output.tail)
  return stripped.length <= MAX_OUTPUT_CHARS
    ? stripped
    : `${stripped.slice(0, HEAD_CHARS)}\n…(trimmed ${stripped.length - MAX_OUTPUT_CHARS} chars)…\n${stripped.slice(-TAIL_CHARS)}`
}

function firstNumber(pattern: RegExp, text: string): number | undefined {
  const match = pattern.exec(text)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

function parseSummary(output: string): TestSummary {
  const passed = firstNumber(/(\d+)\s+pass(?:ed)?\b/i, output)
  const failed = firstNumber(/(\d+)\s+fail(?:ed)?\b/i, output)
  const skipped = firstNumber(/(\d+)\s+skip(?:ped)?\b/i, output)
  const expectations = firstNumber(/(\d+)\s+expect(?:ation)?s?\b/i, output)
  const files = firstNumber(/(\d+)\s+files?\b/i, output)
  return {
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
    ...(skipped !== undefined ? { skipped } : {}),
    ...(expectations !== undefined ? { expectations } : {}),
    ...(files !== undefined ? { files } : {}),
  }
}

/** Run `bun test` in a project with bounded runtime and bounded output. Arguments are argv entries,
 * never a shell string, so an agent can safely pass a path pattern without command injection risk. */
export async function collectTestResult(
  cwd: string,
  args: TestToolArgs = {},
  opts: { readonly signal?: AbortSignal } = {},
): Promise<TestToolResult> {
  let pattern: string | undefined
  let timeoutMs: number
  try {
    pattern = normalizePattern(args.pattern, cwd)
    timeoutMs = normalizeTimeout(args.timeoutMs)
  } catch (err) {
    return {
      ok: false,
      command: ["bun", "test"],
      durationMs: 0,
      exitCode: null,
      timedOut: false,
      summary: {},
      stdout: "",
      stderr: "",
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const command = ["bun", "test", ...(pattern === undefined ? [] : [pattern])]
  const started = Date.now()
  if (opts.signal?.aborted) {
    return {
      ok: false,
      command,
      durationMs: 0,
      exitCode: null,
      timedOut: false,
      cancelled: true,
      summary: {},
      stdout: "",
      stderr: "",
      error:
        typeof opts.signal.reason === "string" && opts.signal.reason.length > 0
          ? `cancelled: ${opts.signal.reason}`
          : "cancelled",
    }
  }
  // The running Bun, not the first `bun` on PATH: an MCP client may start the server with no `bun` there.
  const proc = Bun.spawn([process.execPath, ...command.slice(1)], {
    cwd,
    // Explicit: without `env`, Bun passes the environment it started with, missing `--env-file` values.
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  let cancelled = false
  const abort = (): void => {
    cancelled = true
    proc.kill()
  }
  opts.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const empty: HeadTailOutput = { head: "", tail: "", droppedBytes: 0 }
  let stdoutRaw = empty
  let stderrRaw = empty
  let exitCode: number | null = null
  try {
    // Drained to the end but held to what the result shows, so a test run that prints without limit
    // cannot grow the server's memory with it.
    const result = await Promise.all([
      readHeadTail(proc.stdout, HEAD_BYTES, TAIL_BYTES),
      readHeadTail(proc.stderr, HEAD_BYTES, TAIL_BYTES),
      proc.exited,
    ])
    stdoutRaw = result[0]
    stderrRaw = result[1]
    exitCode = result[2]
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", abort)
  }
  const stdout = clean(stdoutRaw)
  const stderr = clean(stderrRaw)
  const combined = `${stdout}\n${stderr}`
  return {
    ok: exitCode === 0 && !timedOut && !cancelled,
    command,
    durationMs: Date.now() - started,
    exitCode,
    timedOut,
    ...(cancelled ? { cancelled: true } : {}),
    summary: parseSummary(combined),
    stdout,
    stderr,
    ...(cancelled
      ? {
          error:
            typeof opts.signal?.reason === "string" && opts.signal.reason.length > 0
              ? `cancelled: ${opts.signal.reason}`
              : "cancelled",
        }
      : {}),
  }
}
