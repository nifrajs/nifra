import { publicErrorDetails } from "./errors.ts"
import { readBoundedText } from "./process.ts"

export interface VerificationResult {
  readonly name: "check" | "assure" | "test"
  readonly ok: boolean
  readonly status: number | null
  readonly report?: unknown
  readonly output?: string
  readonly error?: string
  readonly stack?: string
}

export interface VerificationRepairTask {
  readonly id: string
  readonly verification: VerificationResult["name"]
  readonly cwd: string
  readonly reason: string
  readonly capabilities: readonly string[]
  readonly output?: string
  readonly report?: unknown
  readonly stack?: string
}

/** Turn a failed gate into a bounded, auditable repair task for the agent loop. */
export function createVerificationRepairTask(
  result: VerificationResult,
  cwd: string,
): VerificationRepairTask | undefined {
  if (result.ok) return undefined
  return Object.freeze({
    id: `verification-${result.name}-${Date.now().toString(36)}`,
    verification: result.name,
    cwd,
    reason:
      result.error ??
      `${result.name} failed${result.status === null ? "" : ` with exit ${result.status}`}`,
    capabilities: Object.freeze(["process", "read", "write"]),
    ...(result.output === undefined ? {} : { output: result.output.slice(0, 32_768) }),
    ...(result.report === undefined ? {} : { report: result.report }),
    ...(result.stack === undefined ? {} : { stack: result.stack }),
  })
}

export interface VerificationOptions {
  readonly cwd: string
  readonly command?: string
  /** Arguments placed before the gate name; useful for portable interpreter-backed test commands. */
  readonly commandArgs?: readonly string[]
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly exposeErrorStacks?: boolean
}

export type ReviewExecutionErrorCode =
  | "timeout"
  | "output-truncated"
  | "invalid-report"
  | "spawn-failed"

export interface ReviewOptions {
  readonly cwd: string
  readonly command?: string
  readonly commandArgs?: readonly string[]
  readonly strict?: boolean
  readonly diff?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface ReviewExecutionResult {
  readonly name: "review"
  readonly ok: boolean
  readonly status: number | null
  /** A parsed, content-free ReviewReport. Raw stdout/stderr is intentionally never returned. */
  readonly report?: unknown
  readonly errorCode?: ReviewExecutionErrorCode
}

const REVIEW_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,255}$/

/** Validate the only repository selector exposed by the host review RPC. */
export function isSafeReviewDiff(value: unknown): value is string {
  return (
    typeof value === "string" &&
    REVIEW_GIT_REF.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === ".." || part.startsWith("."))
  )
}

/** Run `nifra review --json` with the same bounded process discipline as the existing gates. */
export async function runNifraReview(options: ReviewOptions): Promise<ReviewExecutionResult> {
  if (options.strict !== undefined && typeof options.strict !== "boolean")
    throw new TypeError("review strict must be a boolean")
  if (options.diff !== undefined && !isSafeReviewDiff(options.diff))
    throw new TypeError("review diff is not a safe Git ref")
  const command = options.command ?? "nifra"
  const commandArgs = options.commandArgs ?? []
  const args = ["review", "--json"]
  if (options.strict === true) args.push("--strict")
  if (options.diff !== undefined) args.push("--diff", options.diff)
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([command, ...commandArgs, ...args], {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: safeEnv(options.env),
    })
  } catch {
    return { name: "review", ok: false, status: null, errorCode: "spawn-failed" }
  }
  const timeoutMs = options.timeoutMs ?? 120_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  try {
    const [stdout, stderr, status] = await Promise.all([
      readBoundedText(proc.stdout, options.maxOutputBytes ?? 1_048_576),
      readBoundedText(proc.stderr, options.maxOutputBytes ?? 1_048_576),
      proc.exited,
    ])
    void stderr
    if (timedOut) return { name: "review", ok: false, status, errorCode: "timeout" }
    if (stdout.truncated || stderr.truncated)
      return { name: "review", ok: false, status, errorCode: "output-truncated" }
    try {
      const raw = JSON.parse(stdout.text) as unknown
      const { parseReviewReport } = await import("@nifrajs/agent-review")
      const report = await parseReviewReport(raw)
      return {
        name: "review",
        ok: status === 0 && report.ok,
        status,
        report,
      }
    } catch {
      return { name: "review", ok: false, status, errorCode: "invalid-report" }
    }
  } catch {
    return {
      name: "review",
      ok: false,
      status: null,
      errorCode: timedOut ? "timeout" : "spawn-failed",
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Run an existing Nifra gate without importing the large framework CLI into the agent runtime. */
export async function runNifraVerification(
  name: "check" | "assure" | "test",
  options: VerificationOptions,
): Promise<VerificationResult> {
  const command = options.command ?? "nifra"
  const commandArgs = options.commandArgs ?? []
  const args = name === "test" ? ["test"] : [name, "--json"]
  const proc = Bun.spawn([command, ...commandArgs, ...args], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: safeEnv(options.env),
  })
  const timeoutMs = options.timeoutMs ?? 120_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  try {
    const [stdout, stderr, status] = await Promise.all([
      readBoundedText(proc.stdout, options.maxOutputBytes ?? 1_048_576),
      readBoundedText(proc.stderr, options.maxOutputBytes ?? 1_048_576),
      proc.exited,
    ])
    const output = stdout.text || stderr.text
    let report: unknown
    try {
      report = JSON.parse(stdout.text)
    } catch {
      report = undefined
    }
    return {
      name,
      ok: !timedOut && status === 0,
      status,
      ...(report === undefined ? {} : { report }),
      ...(output.length === 0 ? {} : { output }),
      ...(timedOut ? { error: `nifra ${name} timed out after ${timeoutMs}ms` } : {}),
    }
  } catch (error) {
    const details = publicErrorDetails(
      error,
      "verification failed",
      options.exposeErrorStacks === true,
    )
    return {
      name,
      ok: false,
      status: null,
      error: details.message,
      ...(details.stack === undefined ? {} : { stack: details.stack }),
    }
  } finally {
    clearTimeout(timer)
  }
}

function safeEnv(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of new Set([
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TERM",
    "CI",
    ...Object.keys(overrides ?? {}),
  ])) {
    const value =
      overrides !== undefined && Object.hasOwn(overrides, name)
        ? overrides[name]
        : process.env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}
