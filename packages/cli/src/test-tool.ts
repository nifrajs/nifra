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
const MAX_OUTPUT_CHARS = 12_000

function normalizePattern(value: unknown): string | undefined {
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

function clean(text: string): string {
  const stripped = text.replace(ANSI, "")
  return stripped.length <= MAX_OUTPUT_CHARS
    ? stripped
    : `${stripped.slice(0, 4_000)}\n…(trimmed ${stripped.length - MAX_OUTPUT_CHARS} chars)…\n${stripped.slice(-8_000)}`
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
    pattern = normalizePattern(args.pattern)
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
  const proc = Bun.spawn(command, {
    cwd,
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
  let stdoutRaw = ""
  let stderrRaw = ""
  let exitCode: number | null = null
  try {
    const result = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
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
