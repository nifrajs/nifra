/**
 * Transport seam for the Agent App SDK. The client speaks only these two verbs - a request/response
 * `command` and a Server-Sent-Events `stream` - so a fake, a replay driver, and a real loopback RPC
 * host are interchangeable behind one interface.
 *
 * Caller credentials are never stored on the transport. The optional {@link AuthProvider} is invoked
 * per request to mint a bearer token; the token is placed on the outgoing `Authorization` header and
 * is never copied into a result, an error, or a log line.
 */

import {
  type AgentEvent,
  assertTransportByteLimit,
  isAgentEvent,
  MAX_TRANSPORT_BYTES,
  parseTransportContentLength,
  readBoundedTransportBytes,
} from "@nifrajs/agent-protocol"

/** One RPC-style call. `params` is JSON-serializable; `signal` cancels the in-flight request. */
export interface AgentTransportRequest {
  readonly method: string
  readonly params?: unknown
  readonly signal?: AbortSignal
}

/**
 * The outcome of a command. Non-ok responses never throw here so a caller can render a bounded state
 * instead of unwinding; `error` carries only the server's status text, never a credential.
 */
export type CommandOutcome<T> =
  | { readonly ok: true; readonly status: number; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string }

export interface AgentTransport {
  command<T = unknown>(request: AgentTransportRequest): Promise<CommandOutcome<T>>
  stream(request: AgentTransportRequest): AsyncIterable<AgentEvent>
}

/** Returns a bearer token for the next request, or `undefined` for an unauthenticated call. */
export type AuthProvider = () => string | undefined | Promise<string | undefined>

export interface HttpAgentTransportOptions {
  /** RPC origin, e.g. `http://127.0.0.1:8787`. The `/rpc` path is appended. */
  readonly endpoint: string
  /** Per-request bearer-token source. Never stored; only the header value is used and discarded. */
  readonly authorize?: AuthProvider
  /** Injectable fetch for tests and non-DOM hosts. Defaults to the ambient `fetch`. */
  readonly fetch?: typeof fetch
  /** Maximum response bytes retained by command and SSE reads. Defaults to 8 MiB. */
  readonly maxResponseBytes?: number
}

/**
 * Thrown only for transport-level faults (network, malformed body) and for a stream the host refused,
 * which carries the response `status`. Carries no credential.
 */
export class AgentTransportError extends Error {
  constructor(
    readonly method: string,
    reason: string,
    readonly status?: number,
  ) {
    super(`agent transport: ${method}: ${reason}`)
    this.name = "AgentTransportError"
  }
}

/** Web `fetch` + SSE transport. Browser- and Bun-compatible; depends on no Node or framework code. */
export class HttpAgentTransport implements AgentTransport {
  private readonly url: string
  private readonly authorize: AuthProvider | undefined
  private readonly fetchImpl: typeof fetch
  private readonly maxResponseBytes: number

  constructor(options: HttpAgentTransportOptions) {
    if (typeof options.endpoint !== "string" || options.endpoint.length === 0)
      throw new TypeError("agent transport: endpoint is required")
    this.url = `${options.endpoint.replace(/\/$/, "")}/rpc`
    this.authorize = options.authorize
    const bound = options.fetch ?? globalThis.fetch
    if (typeof bound !== "function") throw new TypeError("agent transport: no fetch available")
    this.fetchImpl = bound.bind(globalThis)
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    assertResponseLimit(this.maxResponseBytes)
  }

  private async headers(accept: string): Promise<Headers> {
    const headers = new Headers({ "content-type": "application/json", accept })
    const token = await this.authorize?.()
    if (token !== undefined && token.length > 0) headers.set("authorization", `Bearer ${token}`)
    return headers
  }

  async command<T = unknown>(request: AgentTransportRequest): Promise<CommandOutcome<T>> {
    const body = serialize(request)
    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: await this.headers("application/json"),
        body,
        ...(request.signal ? { signal: request.signal } : {}),
      })
    } catch (error) {
      throw new AgentTransportError(request.method, describe(error))
    }
    const text = await readResponseText(response, request.method, this.maxResponseBytes)
    if (!response.ok)
      return { ok: false, status: response.status, error: text || response.statusText }
    if (text.length === 0) return { ok: true, status: response.status, value: undefined as T }
    try {
      return { ok: true, status: response.status, value: JSON.parse(text) as T }
    } catch {
      throw new AgentTransportError(request.method, "response body was not JSON")
    }
  }

  async *stream(request: AgentTransportRequest): AsyncIterable<AgentEvent> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: await this.headers("text/event-stream"),
        body: serialize(request),
        ...(request.signal ? { signal: request.signal } : {}),
      })
    } catch (error) {
      throw new AgentTransportError(request.method, describe(error))
    }
    if (!response.ok) {
      const text = await readResponseText(response, request.method, this.maxResponseBytes)
      throw new AgentTransportError(
        request.method,
        text || `status ${response.status}`,
        response.status,
      )
    }
    if (response.body === null) return
    yield* parseEventStream(response.body, request.method, this.maxResponseBytes)
  }
}

/** Parse an SSE body into protocol events, skipping any frame whose data is not a valid event. */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
  method: string,
  maxFrameBytes = DEFAULT_MAX_RESPONSE_BYTES,
): AsyncIterable<AgentEvent> {
  assertResponseLimit(maxFrameBytes)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const frameParts: string[] = []
  const appendFramePart = (text: string): void => {
    if (text.length === 0) return
    const lastIndex = frameParts.length - 1
    const previous = frameParts[lastIndex]
    // Tiny network reads must not allocate one retained array entry per byte of a large frame.
    if (previous !== undefined && previous.length + text.length <= 4096)
      frameParts[lastIndex] = previous + text
    else frameParts.push(text)
  }
  let frameBytes = 0
  let buffer = ""
  let reachedEof = false
  try {
    for (;;) {
      const chunk = await reader.read()
      reachedEof = chunk.done
      const decoded = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      frameBytes += encoder.encode(decoded).byteLength
      buffer += decoded
      let boundary = sseBoundary(buffer)
      while (boundary !== undefined) {
        appendFramePart(buffer.slice(0, boundary.index))
        const frame = frameParts.join("")
        frameParts.length = 0
        const completedBytes = encoder.encode(frame).byteLength
        // Delimiters contain only CR/LF, so their code-unit and UTF-8 byte lengths are equal.
        frameBytes -= completedBytes + boundary.end - boundary.index
        buffer = buffer.slice(boundary.end)
        if (completedBytes > maxFrameBytes)
          throw new AgentTransportError(method, "SSE frame exceeds the configured response limit")
        const event = frameToEvent(frame)
        if (event !== undefined) yield event
        boundary = sseBoundary(buffer)
      }
      if (frameBytes > maxFrameBytes)
        throw new AgentTransportError(method, "SSE frame exceeds the configured response limit")
      if (chunk.done) {
        appendFramePart(buffer)
        const event = frameToEvent(frameParts.join(""))
        if (event !== undefined) yield event
        break
      }
      // Scan only new text plus the possible split delimiter. Joining an incomplete frame on
      // every read would flatten and re-scan it quadratically, even with incremental byte counts.
      let scannedUntil = Math.max(0, buffer.length - 3)
      const tailStart = buffer.charCodeAt(scannedUntil)
      if (tailStart >= 0xdc00 && tailStart <= 0xdfff) scannedUntil -= 1
      if (scannedUntil > 0) appendFramePart(buffer.slice(0, scannedUntil))
      buffer = buffer.slice(scannedUntil)
    }
  } catch (error) {
    if (error instanceof AgentTransportError) throw error
    throw new AgentTransportError(method, describe(error))
  } finally {
    if (!reachedEof) {
      // Releasing a reader lock does not stop the response producer. Cancel the body when a
      // consumer breaks early so sockets, server-side work, and buffered chunks can be reclaimed.
      try {
        await reader.cancel()
      } catch {
        // Preserve the original transport/read error, or the consumer's early-return semantics.
      }
    }
    reader.releaseLock()
  }
}

function frameToEvent(frame: string): AgentEvent | undefined {
  const data = frame
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
  if (data.length === 0) return undefined
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return undefined
  }
  return isAgentEvent(value) ? value : undefined
}

function sseBoundary(value: string): { readonly index: number; readonly end: number } | undefined {
  for (let index = 0; index < value.length; index++) {
    const firstLength = lineEndingLength(value, index)
    if (firstLength === undefined) return undefined
    if (firstLength === 0) continue
    const secondIndex = index + firstLength
    const secondLength = lineEndingLength(value, secondIndex)
    if (secondLength === undefined) return undefined
    if (secondLength > 0) return { index, end: secondIndex + secondLength }
    index = secondIndex
  }
  return undefined
}

function lineEndingLength(value: string, index: number): number | undefined {
  const character = value[index]
  if (character === "\n") return 1
  if (character !== "\r") return 0
  if (index + 1 >= value.length) return undefined
  return value[index + 1] === "\n" ? 2 : 1
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE_BYTES = MAX_TRANSPORT_BYTES

function assertResponseLimit(value: number): void {
  assertTransportByteLimit(value, {
    minimum: 1_024,
    maximum: MAX_RESPONSE_BYTES,
    label: "agent transport: maxResponseBytes",
  })
}

async function readResponseText(
  response: Response,
  method: string,
  maxBytes: number,
): Promise<string> {
  const declared = parseTransportContentLength(response.headers.get("content-length"))
  if (declared !== undefined && declared > maxBytes) {
    try {
      await response.body?.cancel()
    } catch {
      // The response is already over its cap; cancellation failure must not replace the useful error.
    }
    throw new AgentTransportError(method, "response body exceeds the configured limit")
  }
  if (response.body === null) return ""
  const read = await readBoundedTransportBytes(response.body, maxBytes)
  if (!read.ok) {
    throw new AgentTransportError(
      method,
      read.reason === "too-large"
        ? "response body exceeds the configured limit"
        : describe(read.error),
    )
  }
  return new TextDecoder().decode(read.bytes)
}

function serialize(request: AgentTransportRequest): string {
  return JSON.stringify({
    method: request.method,
    ...(request.params === undefined ? {} : { params: request.params }),
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
