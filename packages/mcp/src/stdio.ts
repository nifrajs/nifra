/**
 * The MCP stdio transport: newline-delimited JSON-RPC 2.0 over a byte stream. It runs on Bun, Node and
 * Deno - the default streams are `process.stdin` / `process.stdout`, and nothing here touches a
 * runtime-specific API.
 *
 * {@link serveStdio} serves a {@link McpServer} from {@link ./server.ts}:
 *
 * ```ts
 * import { createMcpServer } from "@nifrajs/mcp"
 * import { serveStdio } from "@nifrajs/mcp/stdio"
 *
 * await serveStdio(createMcpServer({ name: "orders", version: "1.0.0", tools }))
 * ```
 *
 * {@link runStdioTransport} is the framing layer underneath, for a host that dispatches messages itself
 * (the `nifra mcp` dev server does: it answers some methods before the project loads, and consumes the
 * client's answer to its own `roots/list` request).
 *
 * stdio is a local, single-client transport. The HTTP options of `createMcpServer` (`allowedOrigins`,
 * `allowedHosts`, `authorizeMessage`) do not apply: whoever can write to the process's stdin can call
 * every tool. Anything the host prints to stdout outside {@link StdioConnection.send} corrupts the
 * stream, so log to stderr.
 */

import {
  createMcpProtocolState,
  handleRpc,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  rpcError,
} from "./protocol.ts"
import type { McpServer } from "./server.ts"

/** Default cap on one message, in either direction, in UTF-8 bytes. */
export const MAX_STDIO_MESSAGE_BYTES = 8 * 1024 * 1024

/** Anything one side of the connection may send. */
export type StdioMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

/** Where encoded lines go. `process.stdout` satisfies it. */
export interface StdioOutput {
  write(chunk: string): unknown
}

export interface StdioConnection {
  /**
   * Write one message as one line. A message that cannot be serialized, or whose encoding exceeds the
   * message cap, is replaced by a `-32603` error carrying the same id, so the peer still gets an answer.
   */
  send(message: StdioMessage): void
}

export interface StdioTransportOptions {
  /** Default `process.stdin`. String chunks are UTF-8 encoded before framing. */
  readonly input?: AsyncIterable<Uint8Array | string>
  /** Default `process.stdout`. */
  readonly output?: StdioOutput
  /** Cap on one message in UTF-8 bytes, in either direction. Default {@link MAX_STDIO_MESSAGE_BYTES}. */
  readonly maxMessageBytes?: number
  /**
   * A client request or notification. Resolve to its response, or `null` to send none. Requests are
   * dispatched concurrently as their lines arrive. A rejection is answered with a generic `-32603`
   * error for a request and with nothing for a notification - the rejection's message is never sent.
   */
  readonly onRequest: (
    message: JsonRpcRequest,
    connection: StdioConnection,
  ) => Promise<JsonRpcResponse | null>
  /**
   * A response to a request this side sent through {@link StdioConnection.send}. Return `false` when no
   * request with that id is pending, and the line is answered as an Invalid Request. Omitted, every
   * response is invalid.
   */
  readonly onResponse?: (message: JsonRpcResponse, connection: StdioConnection) => boolean
}

const ENCODER = new TextEncoder()
const NEWLINE = 0x0a

/**
 * Read newline-delimited JSON-RPC messages from `input` until it ends, dispatching each, then wait for
 * every dispatched request to settle. Resolves once all responses are written.
 *
 * A line over the cap is answered with one `-32600` error and skipped up to its newline without being
 * buffered; invalid UTF-8 and invalid JSON are answered with `-32700`. A final line without a newline
 * is processed at end of input.
 */
export async function runStdioTransport(options: StdioTransportOptions): Promise<void> {
  const maxBytes = options.maxMessageBytes ?? MAX_STDIO_MESSAGE_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("runStdioTransport: maxMessageBytes must be a positive safe integer")
  }
  const input = options.input ?? processStdin()
  const output = options.output ?? processStdout()
  const decoder = new TextDecoder("utf-8", { fatal: true })

  const send = (message: StdioMessage): void => {
    output.write(`${encodeBounded(message, maxBytes)}\n`)
  }
  const connection: StdioConnection = { send }
  const inFlight = new Set<Promise<void>>()
  // A write that throws inside a dispatch is kept and rethrown once the input ends, so a broken
  // output fails the transport instead of becoming an unhandled rejection.
  let writeFailure: { readonly error: unknown } | undefined

  const dispatch = (message: JsonRpcRequest): void => {
    const tracked: Promise<void> = options
      .onRequest(message, connection)
      .then(
        (response) => {
          if (response !== null) send(response)
        },
        () => {
          if (message.id !== undefined) send(rpcError(message.id, -32603, "Internal error"))
        },
      )
      .catch((error: unknown) => {
        writeFailure ??= { error }
      })
      .finally(() => inFlight.delete(tracked))
    inFlight.add(tracked)
  }

  const processLine = (bytes: Uint8Array): void => {
    let text: string
    try {
      text = decoder.decode(bytes)
    } catch {
      send(rpcError(null, -32700, "parse error"))
      return
    }
    const line = text.trim()
    if (line === "") return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      send(rpcError(null, -32700, "parse error"))
      return
    }
    if (isJsonRpcRequest(parsed)) dispatch(parsed)
    else if (!(isJsonRpcResponse(parsed) && options.onResponse?.(parsed, connection) === true)) {
      // null, arrays, scalars, malformed envelopes and responses to no pending request all land here,
      // so no hostile shape reaches a handler.
      send(rpcError(null, -32600, "Invalid Request"))
    }
  }

  let parts: Uint8Array[] = []
  let partBytes = 0
  // Set while the rest of an over-cap line is skipped; the next newline clears it.
  let skipping = false

  const append = (part: Uint8Array, retain: boolean): void => {
    if (skipping || part.byteLength === 0) return
    if (partBytes + part.byteLength > maxBytes) {
      parts = []
      partBytes = 0
      skipping = true
      send(rpcError(null, -32600, "MCP message exceeded the size limit"))
      return
    }
    // A partial line outlives its chunk, so it keeps a copy; a stream may reuse the chunk's buffer.
    parts.push(retain ? part.slice() : part)
    partBytes += part.byteLength
  }

  const endLine = (): void => {
    if (skipping) {
      skipping = false
      return
    }
    const [only] = parts
    const bytes = parts.length === 1 && only !== undefined ? only : concat(parts, partBytes)
    parts = []
    partBytes = 0
    processLine(bytes)
  }

  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? ENCODER.encode(chunk) : chunk
    let start = 0
    let newline = bytes.indexOf(NEWLINE, start)
    while (newline !== -1) {
      append(bytes.subarray(start, newline), false)
      endLine()
      start = newline + 1
      newline = bytes.indexOf(NEWLINE, start)
    }
    if (start < bytes.byteLength) append(bytes.subarray(start), true)
  }
  if (partBytes > 0) endLine()

  while (inFlight.size > 0) await Promise.all(inFlight)
  if (writeFailure !== undefined) throw writeFailure.error
}

export interface ServeStdioOptions extends Omit<StdioTransportOptions, "onRequest" | "onResponse"> {
  /**
   * Answer a throwing tool with its error message instead of only "Tool execution failed". Paths, SQL
   * diagnostics and provider responses end up in error messages; enable it only when every process that
   * can write to stdin may read them.
   */
  readonly exposeToolErrors?: boolean
}

/**
 * Serve `server`'s tools, resources and prompts over stdio until the input ends. One process is one
 * session: request cancellation (`notifications/cancelled`) and progress notifications work as they
 * do over HTTP.
 */
export function serveStdio(server: McpServer, options: ServeStdioOptions = {}): Promise<void> {
  const state = createMcpProtocolState()
  const { exposeToolErrors, ...transport } = options
  return runStdioTransport({
    ...transport,
    onRequest: (message, connection) =>
      handleRpc(message, server.tools, server.serverInfo, server.features, {
        state,
        sendNotification: connection.send,
        exposeToolErrors: exposeToolErrors === true,
      }),
  })
}

function encodeBounded(message: StdioMessage, maxBytes: number): string {
  let encoded: string
  try {
    encoded = JSON.stringify(message)
  } catch {
    return JSON.stringify(rpcError(idOf(message), -32603, "MCP response is not serializable"))
  }
  // A UTF-16 code unit encodes to at most 3 UTF-8 bytes, so short messages skip the encode.
  if (encoded.length * 3 > maxBytes && ENCODER.encode(encoded).byteLength > maxBytes) {
    return JSON.stringify(rpcError(idOf(message), -32603, "MCP response exceeded the size limit"))
  }
  return encoded
}

function idOf(message: StdioMessage): string | number | null {
  if (!("id" in message)) return null
  const id = message.id
  return typeof id === "string" || typeof id === "number" ? id : null
}

function concat(parts: readonly Uint8Array[], byteLength: number): Uint8Array {
  const out = new Uint8Array(byteLength)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function processStream(name: "stdin" | "stdout"): unknown {
  const host: unknown = Reflect.get(globalThis, "process")
  return host !== null && typeof host === "object" ? Reflect.get(host, name) : undefined
}

function isInput(value: unknown): value is AsyncIterable<Uint8Array | string> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, Symbol.asyncIterator) === "function"
  )
}

function isOutput(value: unknown): value is StdioOutput {
  return (
    value !== null && typeof value === "object" && typeof Reflect.get(value, "write") === "function"
  )
}

function processStdin(): AsyncIterable<Uint8Array | string> {
  const stream = processStream("stdin")
  if (isInput(stream)) return stream
  throw new TypeError("@nifrajs/mcp/stdio: this runtime has no process.stdin; pass `input`")
}

function processStdout(): StdioOutput {
  const stream = processStream("stdout")
  if (isOutput(stream)) return stream
  throw new TypeError("@nifrajs/mcp/stdio: this runtime has no process.stdout; pass `output`")
}
