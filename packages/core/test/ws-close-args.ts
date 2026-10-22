/**
 * Checks of `ws.close()` over a real socket, run by the Bun, Node and Deno suites.
 *
 * - A close RFC 6455 forbids throws a `RangeError` on every runtime, and the socket stays open to
 *   answer and close cleanly afterwards. Bun and Deno used to send such a close on the wire, Node's
 *   `ws` threw with the socket left half-open, and workerd threw.
 * - The `close` callback is given the server's own close when the server closed first. Node, Deno
 *   and workerd used to report the peer's echo, which drops the reason, and Node reported 1006 for
 *   its own 1009.
 *
 * Each suite registers the routes on its own app. `node:net` is here because Bun, Node and Deno all
 * provide it.
 */
import { connect } from "node:net"

interface CloseRoutable {
  ws(path: string, handler: object): unknown
}

interface ClosingSocket {
  close(code?: number, reason?: string): void
  send(data: string): void
}

/** Each as `[code, reason]`; `null` leaves the argument out. */
export const FORBIDDEN_CLOSES: readonly (readonly [number | null, string | null])[] = [
  [Number.NaN, null],
  [999, "bye"],
  [1004, null],
  [1005, null],
  [1006, null],
  [1015, null],
  [2999, null],
  [5000, null],
  [1000.5, null],
  [1000, "r".repeat(124)],
  [1000, "é".repeat(62)],
  [null, "a reason without a code"],
]

/** `/close` reads `[code, reason]` and closes with them, answering `range` when that throws. */
export function closeArgsRoute<App extends CloseRoutable>(app: App): App {
  app.ws("/close", {
    message: (ws: ClosingSocket, data: unknown) => {
      const [code, reason]: [number | string | null, string | null] = JSON.parse(String(data))
      try {
        ws.close(code === null ? undefined : Number(code), reason ?? undefined)
      } catch (error) {
        ws.send(error instanceof RangeError ? "range" : `other ${String(error)}`)
      }
    },
  })
  return app
}

/** What the client heard for each forbidden close, then how a close of 4000 "ok" ended it. */
export async function closeArgsAnswers(
  port: number,
): Promise<{ readonly answers: string[]; readonly closed: { code: number; reason: string } }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/close`)
  const messages: string[] = []
  let waiting: (() => void) | undefined
  socket.addEventListener("message", (event) => {
    messages.push(String(event.data))
    waiting?.()
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    ),
  )
  await new Promise((resolve) => socket.addEventListener("open", resolve))
  for (const [code, reason] of FORBIDDEN_CLOSES) {
    const answered = new Promise<void>((resolve) => {
      waiting = resolve
    })
    // JSON has no NaN: the code goes as text, and `Number` reads it back.
    socket.send(JSON.stringify([code === null ? null : String(code), reason]))
    await answered
  }
  socket.send(JSON.stringify(["4000", "ok"]))
  return { answers: messages, closed: await closed }
}

/** The closes `/report` is asked for. A close with no code is left out: Bun sends 1000 for it. */
export const SERVER_CLOSES: readonly (readonly [number, string])[] = [
  [4000, "bye"],
  [1001, "going away"],
  [3000, "é"],
  [1000, ""],
]

/** The payload cap the `/report` app is built with. */
export const REPORT_CAP = 32

/** What `close` is given for each of {@link SERVER_CLOSES}, then for a message over the cap. */
export const SERVER_CLOSE_REPORTS: readonly string[] = [
  ...SERVER_CLOSES.map(([code, reason]) => `${code} ${reason}`),
  "1009 message too large",
]

/**
 * `/report` closes with the `[code, reason]` its message names. The returned function waits for the
 * next `code reason` the route's `close` callback was given.
 */
export function closeReportRoute<App extends CloseRoutable>(app: App): () => Promise<string> {
  const heard: string[] = []
  let wake: (() => void) | undefined
  app.ws("/report", {
    message: (ws: ClosingSocket, data: unknown) => {
      const [code, reason]: [number, string] = JSON.parse(String(data))
      ws.close(code, reason)
    },
    close: (_ws: ClosingSocket, code: number, reason: string) => {
      heard.push(`${code} ${reason}`)
      wake?.()
    },
  })
  return async () => {
    while (heard.length === 0)
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    return heard.shift() ?? ""
  }
}

/** A masked client frame with a payload under 126 bytes. */
function clientFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const mask = [1, 2, 3, 4]
  const frame = new Uint8Array(6 + payload.length)
  frame.set([0x80 | opcode, 0x80 | payload.length, ...mask])
  payload.forEach((byte, i) => {
    frame[6 + i] = byte ^ (mask[i % 4] ?? 0)
  })
  return frame
}

/**
 * Send `message` to `/report` over a raw socket and answer the server's close with its code alone,
 * as RFC 6455 section 5.5.1 has an endpoint echo it. A standard client may echo the reason too,
 * which hid the reason a runtime lost.
 */
function rawReport(port: number, message: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1")
    let pending = new Uint8Array(0)
    let open = false
    socket.on("connect", () => {
      socket.write(
        [
          "GET /report HTTP/1.1",
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      )
    })
    socket.on("data", (chunk: Uint8Array) => {
      const joined = new Uint8Array(pending.length + chunk.length)
      joined.set(pending)
      joined.set(chunk, pending.length)
      pending = joined
      if (!open) {
        const end = new TextDecoder("latin1").decode(pending).indexOf("\r\n\r\n")
        if (end < 0) return
        open = true
        pending = pending.subarray(end + 4)
        socket.write(clientFrame(0x1, new TextEncoder().encode(message)))
      }
      // The server's frames here are unmasked and under 126 bytes.
      while (pending.length >= 2 && pending.length >= 2 + ((pending[1] ?? 0) & 0x7f)) {
        const length = (pending[1] ?? 0) & 0x7f
        if (((pending[0] ?? 0) & 0x0f) === 0x8) {
          socket.end(clientFrame(0x8, pending.subarray(2, Math.min(4, 2 + length))))
        }
        pending = pending.subarray(2 + length)
      }
    })
    // Bun drops the connection for a message over the cap, which a client may see as a reset.
    socket.on("error", () => {})
    socket.on("close", () => resolve())
  })
}

/** Each of {@link SERVER_CLOSES} on its own socket, then a message over the cap, as reported. */
export async function closeReports(port: number, next: () => Promise<string>): Promise<string[]> {
  const reports: string[] = []
  const messages = [
    ...SERVER_CLOSES.map((close) => JSON.stringify(close)),
    "x".repeat(REPORT_CAP + 1),
  ]
  for (const message of messages) {
    await rawReport(port, message)
    reports.push(await next())
  }
  return reports
}
