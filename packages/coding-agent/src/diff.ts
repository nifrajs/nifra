import { publicErrorDetails } from "./errors.ts"
import { readBoundedText } from "./process.ts"

export interface ProjectDiffOptions {
  readonly cwd: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly exposeErrorStacks?: boolean
}

export interface ProjectDiffResult {
  readonly ok: boolean
  readonly status: number | null
  readonly output?: string
  readonly truncated?: boolean
  readonly error?: string
  readonly stack?: string
}

/** Read a bounded, non-interactive git diff for review surfaces. No user-supplied git arguments are accepted. */
export async function readProjectDiff(options: ProjectDiffOptions): Promise<ProjectDiffResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxOutputBytes = options.maxOutputBytes ?? 512 * 1024
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000)
    throw new RangeError("project diff: timeoutMs is invalid")
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1024 ||
    maxOutputBytes > 16 * 1024 * 1024
  )
    throw new RangeError("project diff: maxOutputBytes is invalid")
  const proc = Bun.spawn(
    ["git", "--no-pager", "diff", "HEAD", "--no-ext-diff", "--unified=3", "--"],
    {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: safeEnv(),
    },
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  try {
    const [stdout, stderr, status] = await Promise.all([
      readBoundedText(proc.stdout, maxOutputBytes),
      readBoundedText(proc.stderr, Math.min(maxOutputBytes, 64 * 1024)),
      proc.exited,
    ])
    return {
      ok: !timedOut && status === 0,
      status,
      output: stdout.text.length > 0 ? stdout.text : stderr.text,
      ...(stdout.truncated ? { truncated: true } : {}),
      ...(timedOut ? { error: `git diff timed out after ${timeoutMs}ms` } : {}),
    }
  } catch (error) {
    const details = publicErrorDetails(error, "git diff failed", options.exposeErrorStacks === true)
    return {
      ok: false,
      status: null,
      error: details.message,
      ...(details.stack === undefined ? {} : { stack: details.stack }),
    }
  } finally {
    clearTimeout(timer)
  }
}

function safeEnv(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "GIT_PAGER"]) {
    const value = name === "GIT_PAGER" ? "cat" : process.env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}
