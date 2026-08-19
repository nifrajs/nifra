import { readBoundedText } from "./process.ts"

export interface NifraContextOptions {
  readonly cwd: string
  readonly command?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface NifraContextResult {
  readonly ok: boolean
  readonly status: number | null
  readonly output?: string
  readonly report?: unknown
  readonly error?: string
}

/** Project discovery kept outside the framework runtime; it is only spawned when an agent asks for it. */
export async function runNifraContext(options: NifraContextOptions): Promise<NifraContextResult> {
  const proc = Bun.spawn([options.command ?? "nifra", "context"], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: safeEnv(options.env),
  })
  const timeoutMs = options.timeoutMs ?? 30_000
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
    let report: unknown
    try {
      report = JSON.parse(stdout.text)
    } catch {
      report = undefined
    }
    return {
      ok: !timedOut && status === 0,
      status,
      ...(stdout.text || stderr.text ? { output: stdout.text || stderr.text } : {}),
      ...(report === undefined ? {} : { report }),
      ...(timedOut ? { error: `nifra context timed out after ${timeoutMs}ms` } : {}),
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
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
