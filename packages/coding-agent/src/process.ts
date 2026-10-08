export interface BoundedText {
  readonly text: string
  readonly truncated: boolean
}

/** Read at most `maxBytes` of `stream`; `signal` stops the read early with what arrived so far. */
export async function readBoundedText(
  stream: ReadableStream<Uint8Array> | null | undefined | number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedText> {
  if (stream === null || stream === undefined || typeof stream === "number")
    return { text: "", truncated: false }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("bounded process output: maxBytes must be positive")
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let total = 0
  let truncated = false
  const stop = (): void => {
    reader.cancel().catch(() => {})
  }
  if (signal?.aborted) stop()
  else signal?.addEventListener("abort", stop, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        chunks.push(decoder.decode())
        break
      }
      if (value === undefined) continue
      const remaining = maxBytes - total
      if (remaining <= 0) {
        truncated = true
        await reader.cancel()
        break
      }
      if (value.byteLength > remaining) {
        chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }))
        chunks.push(decoder.decode())
        truncated = true
        await reader.cancel()
        break
      }
      total += value.byteLength
      chunks.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    signal?.removeEventListener("abort", stop)
    reader.releaseLock()
  }
  return { text: chunks.join(""), truncated }
}

export interface BoundedProcessOptions {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeoutMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
}

export interface BoundedProcessResult {
  readonly stdout: BoundedText
  readonly stderr: BoundedText
  readonly status: number | null
  readonly timedOut: boolean
}

const KILL_GRACE_MS = 2_000
const PROCESS_GROUPS = process.platform !== "win32"

/**
 * Run a trusted command to completion within `timeoutMs`. On POSIX the child leads its own process
 * group, so a timeout reaches every process it started: SIGTERM, then SIGKILL after a grace period.
 * Once the child is gone, pipes still held open by something outside the group are no longer
 * waited on, so the call always settles.
 */
export async function runBoundedProcess(
  argv: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  const proc = Bun.spawn([...argv], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env,
    detached: PROCESS_GROUPS,
  })
  const signalAll = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      if (PROCESS_GROUPS) process.kill(-proc.pid, signal)
      else proc.kill(signal)
    } catch {
      // The group is already gone.
    }
  }
  const reading = new AbortController()
  const graceMs = Math.min(KILL_GRACE_MS, options.timeoutMs)
  let timedOut = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    signalAll("SIGTERM")
    escalation = setTimeout(() => {
      signalAll("SIGKILL")
      void proc.exited.then(() => reading.abort())
    }, graceMs)
  }, options.timeoutMs)
  try {
    const [stdout, stderr, status] = await Promise.all([
      readBoundedText(proc.stdout, options.maxStdoutBytes, reading.signal),
      readBoundedText(proc.stderr, options.maxStderrBytes, reading.signal),
      proc.exited,
    ])
    return { stdout, stderr, status, timedOut }
  } finally {
    clearTimeout(timer)
    clearTimeout(escalation)
  }
}
