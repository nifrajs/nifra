/**
 * The typed client's WebSocket transport - the runtime behind `api.chat.ws()` for routes declared
 * with `app.ws()`. Uses the platform's global `WebSocket` (browser, Bun, Node 22+, Deno, workerd),
 * mapping the client's `http(s)` base to `ws(s)`. Frames are JSON on the typed surface: `send`
 * encodes, `messages()`/`onMessage` parse text frames (binary frames bypass the typed contract -
 * read them off `raw`). Sends before the socket opens are queued, so the handle never throws.
 */

import { Fifo } from "@nifrajs/core/internal/fifo"
import { formatStandardIssues } from "@nifrajs/core/schema"
import {
  createTransportCodecRegistry,
  decodeTransportFrame,
  encodeTransportFrame,
  plainJsonCodec,
  type TransportCodec,
  type TransportCodecRegistry,
} from "@nifrajs/core/transport-codec"
import { buildQuery } from "./query.ts"
import { hasDotSegment } from "./sendable-path.ts"
import type { WsCallOptions, WsHandle } from "./treaty.ts"

/** Internal handshake between `inProcessClient` and the proxy: in-process apps have no socket. */
export const NO_SOCKET = Symbol.for("@nifrajs/client/no-socket")

// `readyState` values, fixed by the WebSocket standard (an implementation's statics may be absent).
const CONNECTING = 0
const CLOSED = 3
const DEFAULT_MAX_PENDING_MESSAGES = 256

interface WsRuntimeOptions extends WsCallOptions {
  transport?: {
    readonly codec: TransportCodec
    readonly registry?: TransportCodecRegistry
    readonly maxBytes?: number
  }
}

function toWsUrl(base: string, path: string, query: WsCallOptions["query"]): string {
  const search = query === undefined ? "" : buildQuery(query)
  const url = new URL(base + (path === "" ? "/" : path) + (search === "" ? "" : `?${search}`))
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

export function openWebSocket(
  base: string,
  path: string,
  callOptions: WsRuntimeOptions | undefined,
  noSocket: boolean,
): WsHandle<unknown, unknown> {
  if (noSocket) {
    throw new Error(
      "the in-process client cannot open WebSockets (app.fetch has no socket) - listen() the app and connect with client(baseUrl)",
    )
  }
  const WebSocketImpl = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  if (WebSocketImpl === undefined) {
    throw new Error(
      "no global WebSocket in this runtime - .ws() needs one (browser, Bun, Node 22+)",
    )
  }

  if (hasDotSegment(path)) {
    throw new Error(
      'cannot open a WebSocket at a path with a "." or ".." segment - URL parsing removes that segment, so the socket would reach a different route',
    )
  }

  const maxPending = callOptions?.maxPendingMessages ?? DEFAULT_MAX_PENDING_MESSAGES
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new RangeError("websocket maxPendingMessages must be a positive safe integer")
  }
  const url = toWsUrl(base, path, callOptions?.query)
  const socket =
    callOptions?.protocols !== undefined
      ? new WebSocketImpl(url, callOptions.protocols)
      : new WebSocketImpl(url)

  const sendQueue: string[] = []
  const listeners = new Set<(message: unknown) => void>()
  const transport = callOptions?.transport
  const registry =
    transport?.registry ??
    (transport === undefined || transport.codec === plainJsonCodec
      ? createTransportCodecRegistry([plainJsonCodec])
      : createTransportCodecRegistry([plainJsonCodec, transport.codec]))

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener(
      "error",
      (event) => {
        callOptions?.onError?.(event)
        reject(new Error("websocket_connect_failed"))
      },
      { once: true },
    )
  })
  // The rejection is surfaced via `opened` (and `onError`) only for those who look - an unconsumed
  // `opened` on a failed connect must not crash the process with an unhandled rejection.
  opened.catch(() => {})

  socket.addEventListener("open", () => {
    for (const frame of sendQueue) socket.send(frame)
    sendQueue.length = 0
  })
  // A socket that closed before it opened will never send what was queued for it.
  socket.addEventListener("close", () => {
    sendQueue.length = 0
  })
  const deliver = (message: unknown): void => {
    for (const listener of listeners) listener(message)
  }
  const schema = callOptions?.validateReceive
  const validationStopped = new AbortController()
  const validationQueue = new Fifo<{ frame: unknown }>()
  let validating = false
  let received: Promise<void> | undefined
  const reportReceiveError = (error: unknown): void => {
    try {
      callOptions?.onError?.(error)
    } catch {
      // An observer's failure cannot stop the receive queue from draining.
    }
  }
  const drainValidation = async (
    validate: NonNullable<typeof schema>["~standard"],
  ): Promise<void> => {
    try {
      let item = validationQueue.shift()
      while (item !== undefined) {
        validating = true
        try {
          const result = await validate.validate(item.frame)
          if (validationStopped.signal.aborted) return
          if (result.issues === undefined) deliver(result.value)
          else {
            reportReceiveError(
              new TypeError(
                `a received frame does not match validateReceive: ${formatStandardIssues(result.issues)}`,
                { cause: item.frame },
              ),
            )
          }
        } catch (error) {
          if (!validationStopped.signal.aborted) reportReceiveError(error)
        }
        item = validationQueue.shift()
      }
    } finally {
      validating = false
      received = undefined
    }
  }
  const receive =
    schema === undefined
      ? deliver
      : (frame: unknown): void => {
          if (validationQueue.length + (validating ? 1 : 0) >= maxPending) {
            validationQueue.clear()
            validationStopped.abort()
            socket.close(4008, "receive queue full")
            reportReceiveError(new Error("websocket_validation_queue_full"))
            return
          }
          validationQueue.push({ frame })
          received ??= Promise.resolve().then(() => drainValidation(schema["~standard"]))
        }
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string" || validationStopped.signal.aborted) return
    let parsed: unknown
    try {
      parsed =
        transport === undefined
          ? JSON.parse(event.data)
          : decodeTransportFrame(event.data, registry, {
              ...(transport.maxBytes === undefined ? {} : { maxBytes: transport.maxBytes }),
            })
    } catch {
      return // a non-JSON text frame is outside the contract too
    }
    receive(parsed)
  })

  const signal = callOptions?.signal
  if (signal !== undefined) {
    if (signal.aborted) socket.close()
    else {
      const abort = (): void => socket.close()
      signal.addEventListener("abort", abort, { once: true })
      socket.addEventListener("close", () => signal.removeEventListener("abort", abort), {
        once: true,
      })
    }
  }

  const onMessage = (callback: (message: unknown) => void): (() => void) => {
    listeners.add(callback)
    return () => listeners.delete(callback)
  }

  return {
    raw: socket,
    opened,
    send(message: unknown): void {
      const frame =
        transport === undefined
          ? JSON.stringify(message)
          : encodeTransportFrame(message, transport.codec)
      if (socket.readyState === WebSocketImpl.OPEN) socket.send(frame)
      // Queued only while connecting: a closing or closed socket drops the frame, as
      // `WebSocket.send` itself does, rather than holding it in a queue nothing will flush.
      else if (socket.readyState === CONNECTING) sendQueue.push(frame)
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason)
    },
    [Symbol.dispose](): void {
      socket.close()
    },
    onMessage,
    messages(options?: { signal?: AbortSignal }): AsyncIterableIterator<unknown> {
      const buffered = new Fifo<unknown>()
      const pending = new Fifo<(result: IteratorResult<unknown>) => void>()
      let done = false
      const signal = options?.signal

      const push = (message: unknown): void => {
        const resolve = pending.shift()
        if (resolve !== undefined) {
          resolve({ value: message, done: false })
        } else if (buffered.length === maxPending) {
          discard()
          reportReceiveError(new Error("websocket_iterator_queue_full"))
        } else {
          buffered.push(message)
        }
      }
      const end = (): void => {
        if (done) return
        done = true
        unsubscribe()
        socket.removeEventListener("close", closed)
        socket.removeEventListener("error", closed)
        signal?.removeEventListener("abort", discard)
        validationStopped.signal.removeEventListener("abort", discard)
        for (let resolve = pending.shift(); resolve !== undefined; resolve = pending.shift()) {
          resolve({ value: undefined, done: true })
        }
      }
      const discard = (): void => {
        buffered.clear()
        end()
      }
      // A frame still in `validateReceive` arrived before the close, so it is delivered first.
      const closed = (): void => {
        if (received === undefined) end()
        else void received.then(end)
      }

      const unsubscribe = onMessage(push)
      socket.addEventListener("close", closed, { once: true })
      socket.addEventListener("error", closed, { once: true })
      signal?.addEventListener("abort", discard, { once: true })
      validationStopped.signal.addEventListener("abort", discard, { once: true })
      // Already over: no close or abort event is coming to end the iteration.
      if (signal?.aborted === true || validationStopped.signal.aborted) discard()
      else if (socket.readyState === CLOSED) closed()

      const iterator: AsyncIterableIterator<unknown> = {
        [Symbol.asyncIterator]() {
          return this
        },
        next(): Promise<IteratorResult<unknown>> {
          if (buffered.length > 0) {
            return Promise.resolve({ value: buffered.shift(), done: false })
          }
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            pending.push(resolve)
          })
        },
        return(): Promise<IteratorResult<unknown>> {
          discard()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
      return iterator
    },
  }
}
