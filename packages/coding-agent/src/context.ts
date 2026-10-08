import { runBoundedProcess } from "./process.ts"

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
  const timeoutMs = options.timeoutMs ?? 30_000
  try {
    const maxOutputBytes = options.maxOutputBytes ?? 1_048_576
    const { stdout, stderr, status, timedOut } = await runBoundedProcess(
      [options.command ?? "nifra", "context"],
      {
        cwd: options.cwd,
        env: safeEnv(options.env),
        timeoutMs,
        maxStdoutBytes: maxOutputBytes,
        maxStderrBytes: maxOutputBytes,
      },
    )
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
    ...(process.platform === "win32"
      ? [
          "SystemRoot",
          "WINDIR",
          "TEMP",
          "TMP",
          "USERPROFILE",
          "LOCALAPPDATA",
          "APPDATA",
          "COMSPEC",
          "PATHEXT",
          "BUN_INSTALL",
          "HOMEDRIVE",
          "HOMEPATH",
          "USERNAME",
          "USERDOMAIN",
          "ProgramData",
          "ProgramFiles",
          "ProgramFiles(x86)",
        ]
      : []),
    ...Object.keys(overrides ?? {}),
  ])) {
    const value =
      overrides !== undefined && Object.hasOwn(overrides, name) ? overrides[name] : readEnv(name)
    if (value !== undefined) result[name] = value
  }
  return result
}

function readEnv(name: string): string | undefined {
  const exact = process.env[name]
  if (exact !== undefined || process.platform !== "win32") return exact
  const key = Object.keys(process.env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  )
  return key === undefined ? undefined : process.env[key]
}
