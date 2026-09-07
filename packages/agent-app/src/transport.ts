/**
 * Transport seam for the Agent App SDK. The client speaks only these two verbs - a request/response
 * `command` and a Server-Sent-Events `stream` - so a fake, a replay driver, and a real loopback RPC
 * host are interchangeable behind one interface.
 *
 * Caller credentials are never stored on the transport. The optional {@link AuthProvider} is invoked
 * per request to mint a bearer token; the token is placed on the outgoing `Authorization` header and
 * is never copied into a result, an error, or a log line.
 */

import type { AgentEvent } from "@nifrajs/agent-protocol"
import { isAgentEvent } from "@nifrajs/agent-protocol"

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

/** Thrown only for transport-level faults (network, malformed body). Carries no credential. */
export class AgentTransportError extends Error {
  constructor(
    readonly method: string,
    reason: string,
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
      throw new AgentTransportError(request.method, text || `status ${response.status}`)
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
  let buffer = ""
  let reachedEof = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        reachedEof = true
        buffer += decoder.decode()
        let boundary = sseBoundary(buffer)
        while (boundary !== undefined) {
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.end)
          if (encoder.encode(frame).byteLength > maxFrameBytes)
            throw new AgentTransportError(method, "SSE frame exceeds the configured response limit")
          const event = frameToEvent(frame)
          if (event !== undefined) yield event
          boundary = sseBoundary(buffer)
        }
        if (encoder.encode(buffer).byteLength > maxFrameBytes)
          throw new AgentTransportError(method, "SSE frame exceeds the configured response limit")
        const event = frameToEvent(buffer)
        if (event !== undefined) yield event
        break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary = sseBoundary(buffer)
      while (boundary !== undefined) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.end)
        if (encoder.encode(frame).byteLength > maxFrameBytes)
          throw new AgentTransportError(method, "SSE frame exceeds the configured response limit")
        const event = frameToEvent(frame)
        if (event !== undefined) yield event
        boundary = sseBoundary(buffer)
      }
      if (encoder.encode(buffer).byteLength > maxFrameBytes) {
        try {
          await reader.cancel()
        } catch {
          // Preserve the bounded transport error if the source has already closed.
        }
        throw new AgentTransportError(method, "SSE frame exceeds the configured response limit")
      }
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
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

function assertResponseLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_024 || value > MAX_RESPONSE_BYTES)
    throw new RangeError(
      `agent transport: maxResponseBytes must be between 1024 and ${MAX_RESPONSE_BYTES}`,
    )
}

async function readResponseText(
  response: Response,
  method: string,
  maxBytes: number,
): Promise<string> {
  const declared = decimalHeader(response.headers.get("content-length"))
  if (declared !== undefined && declared > maxBytes) {
    try {
      await response.body?.cancel()
    } catch {
      // The response is already over its cap; cancellation failure must not replace the useful error.
    }
    throw new AgentTransportError(method, "response body exceeds the configured limit")
  }
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength > maxBytes - total) {
        try {
          await reader.cancel()
        } catch {
          // Preserve the bounded transport error if the source has already closed.
        }
        throw new AgentTransportError(method, "response body exceeds the configured limit")
      }
      total += value.byteLength
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof AgentTransportError) throw error
    throw new AgentTransportError(method, describe(error))
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

function decimalHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined
  let result = 0
  for (const character of value) {
    result = result * 10 + (character.charCodeAt(0) - 48)
    if (!Number.isSafeInteger(result)) return Number.POSITIVE_INFINITY
  }
  return result
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
