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

  constructor(options: HttpAgentTransportOptions) {
    if (typeof options.endpoint !== "string" || options.endpoint.length === 0)
      throw new TypeError("agent transport: endpoint is required")
    this.url = `${options.endpoint.replace(/\/$/, "")}/rpc`
    this.authorize = options.authorize
    const bound = options.fetch ?? globalThis.fetch
    if (typeof bound !== "function") throw new TypeError("agent transport: no fetch available")
    this.fetchImpl = bound.bind(globalThis)
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
    const text = await response.text()
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
      const text = await response.text()
      throw new AgentTransportError(request.method, text || `status ${response.status}`)
    }
    if (response.body === null) return
    yield* parseEventStream(response.body, request.method)
  }
}

/** Parse an SSE body into protocol events, skipping any frame whose data is not a valid event. */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
  method: string,
): AsyncIterable<AgentEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = frameToEvent(frame)
        if (event !== undefined) yield event
        boundary = buffer.indexOf("\n\n")
      }
    }
  } catch (error) {
    throw new AgentTransportError(method, describe(error))
  } finally {
    reader.releaseLock()
  }
}

function frameToEvent(frame: string): AgentEvent | undefined {
  const data = frame
    .split("\n")
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

function serialize(request: AgentTransportRequest): string {
  return JSON.stringify({
    method: request.method,
    ...(request.params === undefined ? {} : { params: request.params }),
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
