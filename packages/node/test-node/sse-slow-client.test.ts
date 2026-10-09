/**
 * The Node writer waits for the socket to drain before it pulls the next chunk, so a client that
 * stops reading leaves the backlog in the SSE stream's own queue, where maxBufferedBytes drops it.
 */
import assert from "node:assert/strict"
import { connect } from "node:net"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { sse, streaming } from "@nifrajs/core/sse"
import { serve } from "@nifrajs/node"

test("an SSE client that stops reading is dropped instead of buffered without limit", async () => {
  const frame = { data: "x".repeat(16 * 1024) }
  const limit = 2000 // 32 MiB; bounded so a regression fails instead of exhausting memory
  let sends = 0
  let reason: unknown
  let producerDone!: () => void
  const done = new Promise<void>((resolve) => {
    producerDone = resolve
  })
  const app = server()
    .use(streaming())
    .get("/events", (c) =>
      sse(
        c,
        async (stream) => {
          while (sends < limit && !stream.signal.aborted) {
            stream.send(frame)
            sends++
            await new Promise((resolve) => setImmediate(resolve))
          }
          reason = stream.signal.reason
          producerDone()
        },
        { maxBufferedBytes: 256 * 1024 },
      ),
    )
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const socket = connect(running.port, "127.0.0.1")
  try {
    await new Promise<void>((resolve) => socket.once("connect", resolve))
    socket.write("GET /events HTTP/1.1\r\nHost: x\r\n\r\n")
    socket.pause()
    await done
    assert.match(String(reason), /sse_client_too_slow/)
    assert.ok(sends < limit, `${sends} frames were queued`)
  } finally {
    socket.destroy()
    await running.stop({ drainMs: 50 })
  }
})
