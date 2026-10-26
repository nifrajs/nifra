import { publicErrorDetails } from "./errors.ts"
import { safeEnv } from "./internal/safe-env.ts"
import { runBoundedProcess } from "./process.ts"

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
  try {
    const { stdout, stderr, status, timedOut } = await runBoundedProcess(
      ["git", "--no-pager", "diff", "HEAD", "--no-ext-diff", "--unified=3", "--"],
      {
        cwd: options.cwd,
        env: safeEnv({ GIT_PAGER: "cat" }),
        timeoutMs,
        maxStdoutBytes: maxOutputBytes,
        maxStderrBytes: Math.min(maxOutputBytes, 64 * 1024),
      },
    )
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
  }
}
