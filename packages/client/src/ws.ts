/**
 * The typed client's WebSocket transport - the runtime behind `api.chat.ws()` for routes declared
 * with `app.ws()`. Uses the platform's global `WebSocket` (browser, Bun, Node 22+, Deno, workerd),
 * mapping the client's `http(s)` base to `ws(s)`. Frames are JSON on the typed surface: `send`
 * encodes, `messages()`/`onMessage` parse text frames (binary frames bypass the typed contract -
 * read them off `raw`). Sends before the socket opens are queued, so the handle never throws.
 */

import type { WsCallOptions, WsHandle } from "./treaty.ts"

/** Internal handshake between `inProcessClient` and the proxy: in-process apps have no socket. */
export const NO_SOCKET = Symbol.for("@nifrajs/client/no-socket")

interface WsRuntimeOptions extends WsCallOptions {
  headers?: Record<string, string> | undefined
}

function toWsUrl(base: string, path: string, query: WsCallOptions["query"]): string {
  const url = new URL(base + (path === "" ? "/" : path))
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, String(value))
  }
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

  const url = toWsUrl(base, path, callOptions?.query)
  const socket =
    callOptions?.protocols !== undefined
      ? new WebSocketImpl(url, callOptions.protocols)
      : new WebSocketImpl(url)

  const sendQueue: string[] = []
  const listeners = new Set<(message: unknown) => void>()

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
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return // binary frames live off the typed contract
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return // a non-JSON text frame is outside the contract too
    }
    for (const listener of listeners) listener(parsed)
  })

  if (callOptions?.signal !== undefined) {
    if (callOptions.signal.aborted) socket.close()
    else callOptions.signal.addEventListener("abort", () => socket.close(), { once: true })
  }

  const onMessage = (callback: (message: unknown) => void): (() => void) => {
    listeners.add(callback)
    return () => listeners.delete(callback)
  }

  return {
    raw: socket,
    opened,
    send(message: unknown): void {
      const frame = JSON.stringify(message)
      if (socket.readyState === WebSocketImpl.OPEN) socket.send(frame)
      else sendQueue.push(frame)
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason)
    },
    onMessage,
    messages(options?: { signal?: AbortSignal }): AsyncIterableIterator<unknown> {
      const buffered: unknown[] = []
      let pending: ((result: IteratorResult<unknown>) => void) | undefined
      let done = false

      const push = (message: unknown): void => {
        if (pending !== undefined) {
          const resolve = pending
          pending = undefined
          resolve({ value: message, done: false })
        } else {
          buffered.push(message)
        }
      }
      const end = (): void => {
        if (done) return
        done = true
        unsubscribe()
        pending?.({ value: undefined, done: true })
        pending = undefined
      }

      const unsubscribe = onMessage(push)
      socket.addEventListener("close", end, { once: true })
      socket.addEventListener("error", end, { once: true })
      options?.signal?.addEventListener("abort", end, { once: true })

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
            pending = resolve
          })
        },
        return(): Promise<IteratorResult<unknown>> {
          end()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
      return iterator
    },
  }
}
