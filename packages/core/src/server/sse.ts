/**
 * Server-Sent Events — a portable `text/event-stream` response helper.
 *
 * `sse(c, run)` returns a streaming `Response` a handler can return directly. The `run` callback
 * receives a stream it pushes messages to; the connection stays open until `run`'s promise resolves,
 * it calls `stream.close()`, or the client disconnects (`c.req.signal`). Works on every nifra runtime
 * (Bun, Node via `@nifrajs/node`, Deno, Cloudflare/Vercel edge) — it only uses a Web `ReadableStream`.
 *
 *   // finite stream — run resolves, the connection closes
 *   app.get("/ticks", (c) => sse(c, async (stream) => {
 *     for (let i = 0; i < 5; i++) {
 *       stream.send({ event: "tick", data: String(i) })
 *       await new Promise((r) => setTimeout(r, 1000))
 *     }
 *   }))
 *
 *   // event-driven — keep `run` pending until the client leaves
 *   app.get("/feed", (c) => sse(c, (stream) => {
 *     const off = bus.subscribe((e) => stream.send({ data: JSON.stringify(e) }))
 *     return new Promise<void>((resolve) =>
 *       stream.signal.addEventListener("abort", () => { off(); resolve() }, { once: true }))
 *   }, { keepAlive: 15_000 }))
 */

/** One SSE frame. Every field is optional; `data` may be multi-line (emitted as multiple `data:` lines). */
export interface SSEMessage {
  readonly data?: string
  readonly event?: string
  readonly id?: string
  /** Client reconnection delay hint, ms (coerced to an integer). */
  readonly retry?: number
  /** A `: comment` line (e.g. a keep-alive ping). */
  readonly comment?: string
}

/** The stream handed to the `run` callback. */
export interface SSEStream {
  /** Enqueue an event frame. No-op once the stream is closed. */
  send(message: SSEMessage): void
  /** End the stream now. */
  close(): void
  /** Aborts when the client disconnects — use it to tear down subscriptions/loops. */
  readonly signal: AbortSignal
}

/** Minimal context shape `sse` needs — the live request, for its client-disconnect signal. */
export interface SSEContext {
  readonly req: Request
}

export interface SSEInit {
  readonly status?: number
  // Derived from the `Headers` constructor so we don't depend on the DOM lib's `HeadersInit`
  // (core is DOM-free for edge-safety).
  readonly headers?: ConstructorParameters<typeof Headers>[0]
  /** Send a `: ` comment ping every N ms so idle proxies don't drop the connection. */
  readonly keepAlive?: number
}

const CRLF = /[\r\n]/g
const LINE_SPLIT = /\r\n|\r|\n/

/** `event:`/`id:`/`comment` must be single-line — stripping CR/LF prevents SSE frame injection. */
function formatMessage(m: SSEMessage): string {
  let frame = ""
  if (m.comment !== undefined) frame += `: ${m.comment.replace(CRLF, "")}\n`
  if (m.event !== undefined) frame += `event: ${m.event.replace(CRLF, "")}\n`
  if (m.id !== undefined) frame += `id: ${m.id.replace(CRLF, "")}\n`
  if (m.retry !== undefined) frame += `retry: ${Math.trunc(m.retry)}\n`
  if (m.data !== undefined) {
    for (const line of m.data.split(LINE_SPLIT)) frame += `data: ${line}\n`
  }
  return `${frame}\n` // the blank line terminates the event
}

let neverAbort: AbortSignal | undefined
function getNeverAbort(): AbortSignal {
  neverAbort ??= new AbortController().signal
  return neverAbort
}

export function sse(
  c: SSEContext,
  run: (stream: SSEStream) => void | Promise<void>,
  init: SSEInit = {},
): Response {
  const encoder = new TextEncoder()
  const requestSignal: AbortSignal | undefined = c.req?.signal
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let onAbort: (() => void) | undefined

  const teardown = (): void => {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (requestSignal !== undefined && onAbort !== undefined) {
      requestSignal.removeEventListener("abort", onAbort)
    }
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (closed) return
        closed = true
        teardown()
        try {
          controller.close()
        } catch {
          // Already closed by the runtime's cancel() — safe to ignore.
        }
      }
      const stream: SSEStream = {
        send(message) {
          if (!closed) controller.enqueue(encoder.encode(formatMessage(message)))
        },
        close,
        signal: requestSignal ?? getNeverAbort(),
      }

      // Stop the moment the client goes away.
      if (requestSignal !== undefined) {
        if (requestSignal.aborted) {
          close()
          return
        }
        onAbort = close
        requestSignal.addEventListener("abort", onAbort, { once: true })
      }

      if (init.keepAlive !== undefined && init.keepAlive > 0) {
        heartbeat = setInterval(() => stream.send({ comment: "" }), init.keepAlive)
        // Don't let the ping keep a Node process alive on its own.
        ;(heartbeat as { unref?: () => void }).unref?.()
      }
      // An async IIFE so a synchronous throw in `run` becomes a rejection we can surface.
      ;(async () => {
        await run(stream)
      })().then(close, (err: unknown) => {
        if (closed) return
        closed = true
        teardown()
        try {
          controller.error(err instanceof Error ? err : new Error("sse_producer_failed"))
        } catch {
          // Stream already torn down.
        }
      })
    },
    cancel() {
      // Consumer/runtime canceled (client gone) — pending sends become no-ops.
      closed = true
      teardown()
    },
  })

  const headers = new Headers(init.headers)
  headers.set("content-type", "text/event-stream; charset=utf-8")
  headers.set("cache-control", "no-cache, no-transform")
  if (!headers.has("x-accel-buffering")) headers.set("x-accel-buffering", "no") // defeat proxy buffering
  return new Response(body, { status: init.status ?? 200, headers })
}
