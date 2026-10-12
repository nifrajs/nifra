/**
 * Transport-neutral bounded I/O for project MCP tools.
 *
 * HTTP docs and verification WebSocket transport keep their own adapters; stdio/run/render share only
 * these limits and stream readers so an untrusted local endpoint or child process cannot exhaust MCP.
 */

export const CHILD_TIMEOUT_MS = 30_000
/** Maximum stdout or stderr retained from a project subprocess. The process is killed at the limit. */
export const CHILD_OUTPUT_MAX_BYTES = 1_048_576
/** Maximum serialized request sent to a project subprocess or warm worker. */
export const CHILD_INPUT_MAX_BYTES = 4 * 1024 * 1024

/** Local dev-tool reads are intentionally bounded: MCP runs in an agent process and must not hang on or
 * buffer an unrelated loopback service just because a caller supplied its port. */
export const LOCAL_TOOL_FETCH_TIMEOUT_MS = 2_000
export const LOCAL_TOOL_MAX_RESPONSE_BYTES = 1_048_576

/**
 * On POSIX a bounded child is spawned `detached`, leading its own process group, so stopping it
 * reaches every process it started. Otherwise a grandchild still holding the pipes keeps the read,
 * and the tool call, open past its timeout.
 */
export const OWN_PROCESS_GROUP = process.platform !== "win32"

/** Signal a child spawned with `detached: OWN_PROCESS_GROUP`: its whole group on POSIX. */
export function signalProcessGroup(
  proc: { readonly pid: number; kill(signal?: NodeJS.Signals): void },
  signal: NodeJS.Signals,
): void {
  try {
    if (OWN_PROCESS_GROUP) process.kill(-proc.pid, signal)
    else proc.kill(signal)
  } catch {
    // The group has already exited.
  }
}

/** How long a stopped child gets to exit after SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 2_000

/** Stopping a child: `stop` sends SIGTERM, `dispose` drops the SIGKILL still pending once it is done. */
export interface EscalatingStop {
  readonly stop: () => void
  readonly dispose: () => void
}

/**
 * Stop a child with SIGTERM, then SIGKILL once `graceMs` passes. Project code can catch SIGTERM
 * (a graceful-shutdown hook waiting on a hung request), and a child that never exits keeps its
 * caller waiting and outlives it. `send` delivers one signal to the child or its group.
 */
export function escalatingStop(
  send: (signal: NodeJS.Signals) => void,
  graceMs: number = KILL_GRACE_MS,
): EscalatingStop {
  let escalation: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  return {
    stop: () => {
      if (disposed) return
      send("SIGTERM")
      escalation ??= setTimeout(() => send("SIGKILL"), graceMs)
    },
    dispose: () => {
      disposed = true
      clearTimeout(escalation)
    },
  }
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

/**
 * A child in its own group no longer gets the Ctrl+C the terminal sends its parent: on SIGINT,
 * SIGTERM or SIGHUP run `stop`, then let this process take the signal as it would have. Returns the
 * function that removes the listeners.
 */
export function forwardTerminalSignals(stop: () => void): () => void {
  if (!OWN_PROCESS_GROUP) return () => {}
  const remove = (): void => {
    for (const name of FORWARDED_SIGNALS) process.off(name, forward)
  }
  const forward = (signal: NodeJS.Signals): void => {
    stop()
    remove()
    process.kill(process.pid, signal)
  }
  for (const name of FORWARDED_SIGNALS) process.on(name, forward)
  return remove
}

/** Accept only a concrete TCP port. Port 0 (bind-any-free-port) is not a valid read target. */
export function validateLocalPort(port: unknown): number | undefined {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined
}

/** Read a dev-tool response without allowing an untrusted localhost service to allocate unbounded memory. */
export async function readBoundedResponse(
  response: Response,
  maxBytes = LOCAL_TOOL_MAX_RESPONSE_BYTES,
): Promise<string> {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes)
      throw new Error("response exceeded the size limit")
  }
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error("response exceeded the size limit")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export const notNifraResponse = (service: string): string =>
  JSON.stringify(
    {
      code: "NIFRA_NOT_DEV_SERVER",
      message: `The service on this port is not a Nifra ${service} endpoint.`,
    },
    null,
    2,
  )

export const timeoutMessage = (label: string, ms: number): string =>
  `${label} timed out after ${ms / 1000}s and was terminated.\n` +
  `The app was loaded but the process did not finish. Most often this is a module-level side effect ` +
  `that keeps the event loop alive (a database pool, a Redis client, an interval) opened during import ` +
  `rather than lazily. Check for top-level connections in the app entry or anything it imports.`

export interface BoundedOutput {
  readonly text: string
  readonly truncated: boolean
}

export type BoundedLine =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "too-large" }

function decodeLine(chunks: readonly Uint8Array[], totalBytes: number): string {
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** Read newline-delimited input without retaining a line larger than the configured byte budget. */
export async function* readBoundedLines(
  stream: ReadableStream<Uint8Array>,
  maxBytes = CHILD_INPUT_MAX_BYTES,
): AsyncGenerator<BoundedLine> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("maxBytes must be a positive safe integer")
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let tooLarge = false
  for await (const raw of stream) {
    const value = raw as Uint8Array
    let start = 0
    while (start < value.byteLength) {
      const newline = value.indexOf(0x0a, start)
      const end = newline === -1 ? value.byteLength : newline
      const segment = value.subarray(start, end)
      if (!tooLarge) {
        if (totalBytes + segment.byteLength > maxBytes) {
          tooLarge = true
          chunks.length = 0
          totalBytes = 0
        } else if (segment.byteLength > 0) {
          chunks.push(segment)
          totalBytes += segment.byteLength
        }
      }
      if (newline === -1) break
      if (tooLarge) yield { kind: "too-large" }
      else yield { kind: "line", text: decodeLine(chunks, totalBytes) }
      chunks.length = 0
      totalBytes = 0
      tooLarge = false
      start = newline + 1
    }
  }
  if (tooLarge) yield { kind: "too-large" }
  else if (totalBytes > 0) yield { kind: "line", text: decodeLine(chunks, totalBytes) }
}

/** Serialize a JSON value only when its UTF-8 representation fits within the byte budget. */
export function serializeBoundedJson(
  value: unknown,
  maxBytes: number,
  space?: string | number,
): string | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return undefined
  let text: string | undefined
  try {
    text = JSON.stringify(value, null, space)
  } catch {
    return undefined
  }
  if (text === undefined || new TextEncoder().encode(text).byteLength > maxBytes) return undefined
  return text
}

/** What {@link readHeadTail} kept: the start and end of a stream, and how many bytes fell between. */
export interface HeadTailOutput {
  readonly head: string
  readonly tail: string
  /** Bytes dropped between `head` and `tail`; when 0, `head + tail` is the whole stream. */
  readonly droppedBytes: number
}

/**
 * Drain a stream to its end, keeping at most `headBytes` from its start and `tailBytes` from its end,
 * so a child that prints without limit costs bounded memory and still runs to completion.
 */
export async function readHeadTail(
  stream: ReadableStream<Uint8Array>,
  headBytes: number,
  tailBytes: number,
): Promise<HeadTailOutput> {
  const head: Uint8Array[] = []
  let headSize = 0
  const tail: Uint8Array[] = []
  let tailSize = 0
  let droppedBytes = 0
  for await (let chunk of stream) {
    if (headSize < headBytes) {
      const taken = chunk.subarray(0, headBytes - headSize)
      head.push(taken)
      headSize += taken.byteLength
      chunk = chunk.subarray(taken.byteLength)
    }
    if (chunk.byteLength === 0) continue
    tail.push(chunk)
    tailSize += chunk.byteLength
    while (tailSize > tailBytes) {
      const first = tail[0]!
      const excess = tailSize - tailBytes
      if (first.byteLength <= excess) {
        tail.shift()
        tailSize -= first.byteLength
        droppedBytes += first.byteLength
      } else {
        tail[0] = first.subarray(excess)
        tailSize -= excess
        droppedBytes += excess
      }
    }
  }
  const decode = (chunks: readonly Uint8Array[]): string => Buffer.concat(chunks).toString("utf8")
  return { head: decode(head), tail: decode(tail), droppedBytes }
}

/** A {@link HeadTailOutput} as one string, marking where bytes were dropped. */
export function joinHeadTail(output: HeadTailOutput): string {
  return output.droppedBytes === 0
    ? output.head + output.tail
    : `${output.head}\n…(${output.droppedBytes} bytes omitted)…\n${output.tail}`
}

/** Read child output incrementally and cancel as soon as the byte budget is crossed. */
export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes = CHILD_OUTPUT_MAX_BYTES,
  onLimit?: () => void,
): Promise<BoundedOutput> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let totalBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        chunks.push(decoder.decode())
        return { text: chunks.join(""), truncated: false }
      }
      if (value === undefined) continue
      const remaining = maxBytes - totalBytes
      if (remaining <= 0 || value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }))
          chunks.push(decoder.decode())
        }
        await reader.cancel()
        onLimit?.()
        return { text: chunks.join(""), truncated: true }
      }
      totalBytes += value.byteLength
      chunks.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
}
