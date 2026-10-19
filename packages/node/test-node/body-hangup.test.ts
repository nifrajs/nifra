/**
 * A client that leaves partway through a declared request body, on Node itself.
 *
 * Node answers the EOF with `clientError` (`HPE_INVALID_EOF_STATE`) instead of tearing the socket
 * down, and the adapter's `clientError` handler waits for in-flight responses before closing. A
 * response whose handler is still reading the cut-off body never finishes, so the request stayed in
 * flight until `stop()` force-closed it at the drain deadline. Bun's node:http raises no
 * `clientError` here, which is why the Bun-run suite cannot see it.
 */

import { IncomingMessage, Server } from "node:http"
import { connect, type Socket } from "node:net"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

const anyBody = {
  "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
} as const

const PARTIAL_POST =
  "POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1024\r\n\r\n" +
  '{"a"'

/** Resolves with the next request any node:http server in this process dispatches. */
function nextRequest(): Promise<IncomingMessage> {
  const originalEmit = Server.prototype.emit
  return new Promise((resolve) => {
    Server.prototype.emit = new Proxy(originalEmit, {
      apply(emit, emitter: Server, args: unknown[]) {
        const [event, req] = args
        if (event === "request" && req instanceof IncomingMessage) {
          Server.prototype.emit = originalEmit
          resolve(req)
        }
        return Reflect.apply(emit, emitter, args)
      },
    })
  })
}

/** Sends the headers and the start of a 1 KB body, and returns once the server dispatched it. */
async function startPartialPost(port: number): Promise<{ socket: Socket; req: IncomingMessage }> {
  const dispatched = nextRequest()
  const socket = connect(port, "127.0.0.1", () => socket.write(PARTIAL_POST))
  socket.on("error", () => {})
  return { socket, req: await dispatched }
}

function closed(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => req.once("close", () => resolve()))
}

/** Bounds a wait so a regression fails the test instead of keeping the runner alive. */
function within<T>(pending: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} still pending after ${ms} ms`)), ms)
  })
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer))
}

const lanes = {
  "the JSON body lane": () => server().post("/x", { body: anyBody }, (c) => c.body),
  "c.boundedBody()": () =>
    server().post("/x", async (c) => {
      try {
        await c.boundedBody()
      } catch {
        return new Response(null, { status: 400 })
      }
      return "read"
    }),
}

for (const [lane, app] of Object.entries(lanes)) {
  for (const leave of ["destroy", "end"] as const) {
    test(`${lane}: a client that ${leave}s mid-body is let go at once, not at stop()`, async () => {
      const running = await serve(app(), { port: 0, hostname: "127.0.0.1" })
      try {
        const { socket, req } = await startPartialPost(running.port)
        const gone = closed(req)
        socket[leave]()
        await within(gone, 2000, "the dropped request")
        // Nothing is left in flight, so a graceful stop does not sit out the 10 s drain.
        await within(running.stop(), 2000, "stop()")
      } finally {
        await running.stop({ drainMs: 0 })
      }
    })
  }
}

type BodyReader = (c: {
  boundedBody(): Promise<unknown>
  readonly req: Request
}) => Promise<unknown>

const lateReaders: Record<string, BodyReader> = {
  "c.boundedBody()": (c) => c.boundedBody(),
  "c.req.arrayBuffer()": (c) => c.req.arrayBuffer(),
}

for (const [reader, read] of Object.entries(lateReaders)) {
  test(`${reader} started after the client left rejects instead of waiting forever`, async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let rejected!: () => void
    const readRejected = new Promise<void>((resolve) => {
      rejected = resolve
    })
    const app = server().post("/x", async (c) => {
      await released
      try {
        await read(c)
      } catch {
        rejected()
        return new Response(null, { status: 400 })
      }
      return "read"
    })
    const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
    try {
      const { socket, req } = await startPartialPost(running.port)
      const gone = closed(req)
      socket.destroy()
      await within(gone, 2000, "the dropped request")
      release()
      await within(readRejected, 2000, "the late body read")
      await within(running.stop(), 2000, "stop()")
    } finally {
      await running.stop({ drainMs: 0 })
    }
  })
}
