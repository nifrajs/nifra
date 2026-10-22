/**
 * One check of `ws.close()` arguments over a real socket, run by the Bun suite and by the Node
 * adapter's: a close RFC 6455 forbids throws a `RangeError` on every runtime, and the socket stays
 * open to answer and close cleanly afterwards. Bun and Deno used to send such a close on the wire,
 * Node's `ws` threw with the socket left half-open, and workerd threw. The file imports nothing:
 * each suite registers the route on its own app.
 */

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
