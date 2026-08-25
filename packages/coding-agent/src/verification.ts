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
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly exposeErrorStacks?: boolean
}

/** Run an existing Nifra gate without importing the large framework CLI into the agent runtime. */
export async function runNifraVerification(
  name: "check" | "assure" | "test",
  options: VerificationOptions,
): Promise<VerificationResult> {
  const command = options.command ?? "nifra"
  const args = name === "test" ? ["test"] : [name, "--json"]
  const proc = Bun.spawn([command, ...args], {
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
    const value = overrides?.[name] ?? process.env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}
