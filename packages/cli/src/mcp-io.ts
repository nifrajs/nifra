/**
 * Transport-neutral bounded I/O for project MCP tools.
 *
 * HTTP docs and verification WebSocket transport keep their own adapters; stdio/run/render share only
 * these limits and stream readers so an untrusted local endpoint or child process cannot exhaust MCP.
 */

export const CHILD_TIMEOUT_MS = 30_000
/** Maximum stdout or stderr retained from a project subprocess. The process is killed at the limit. */
export const CHILD_OUTPUT_MAX_BYTES = 1_048_576

/** Local dev-tool reads are intentionally bounded: MCP runs in an agent process and must not hang on or
 * buffer an unrelated loopback service just because a caller supplied its port. */
export const LOCAL_TOOL_FETCH_TIMEOUT_MS = 2_000
export const LOCAL_TOOL_MAX_RESPONSE_BYTES = 1_048_576

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
