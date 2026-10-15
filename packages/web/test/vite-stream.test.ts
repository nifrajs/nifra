import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { applyResponseHeaders, pipeWebBodyToNode } from "../src/vite.ts"

// A header sink mock recording setHeader calls (the dev server writes onto a Node ServerResponse).
function mockHeaderSink() {
  const set: Array<[string, string | readonly string[]]> = []
  return {
    set,
    setHeader: (name: string, value: string | readonly string[]) => set.push([name, value]),
  }
}

test("applyResponseHeaders emits multiple Set-Cookie headers separately (not joined)", () => {
  const headers = new Headers()
  headers.append("set-cookie", "app.session_token=abc; Path=/; HttpOnly; SameSite=Lax")
  headers.append("set-cookie", "app.session_data=xyz; Path=/; HttpOnly; SameSite=Lax")
  headers.set("content-type", "application/json")
  const res = mockHeaderSink()

  applyResponseHeaders(headers, res)

  // set-cookie set ONCE as an array of both cookies (never comma-joined); content-type passed through.
  const cookieCalls = res.set.filter(([k]) => k.toLowerCase() === "set-cookie")
  expect(cookieCalls.length).toBe(1)
  const value = cookieCalls[0]?.[1]
  expect(Array.isArray(value)).toBe(true)
  expect(value).toHaveLength(2)
  expect((value as string[])[0]).toContain("session_token=abc")
  expect((value as string[])[1]).toContain("session_data=xyz")
  expect(res.set.some(([k, v]) => k === "content-type" && v === "application/json")).toBe(true)
})

test("applyResponseHeaders sets no Set-Cookie when there are none", () => {
  const headers = new Headers({ "content-type": "text/event-stream" })
  const res = mockHeaderSink()
  applyResponseHeaders(headers, res)
  expect(res.set.some(([k]) => k.toLowerCase() === "set-cookie")).toBe(false)
  expect(res.set.some(([k]) => k === "content-type")).toBe(true)
})

// A minimal Node-ServerResponse mock capturing what the dev server writes.
function mockRes() {
  const chunks: string[] = []
  let ended = false
  let onClose: (() => void) | null = null
  return {
    chunks,
    get ended() {
      return ended
    },
    triggerClose() {
      onClose?.()
    },
    res: {
      flushHeaders() {},
      on(_e: "close", cb: () => void) {
        onClose = cb
      },
      write(c: Uint8Array) {
        chunks.push(new TextDecoder().decode(c))
        return true
      },
      end() {
        ended = true
      },
    },
  }
}

// THE regression: each frame must flush as it arrives. The old code `res.end(await res.arrayBuffer())`
// waited for the whole stream to END - an open-ended SSE body never ends, hanging `nifra dev`.
test("pipeWebBodyToNode flushes each frame as it arrives - does NOT wait for the stream to end (SSE-safe)", async () => {
  const m = mockRes()
  let push!: (s: string) => void
  let close!: () => void
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder()
      push = (s) => c.enqueue(enc.encode(s))
      close = () => c.close()
    },
  })
  const done = pipeWebBodyToNode(body, m.res)
  push("data: frame-1\n\n")
  await new Promise((r) => setTimeout(r, 15))
  expect(m.chunks).toContain("data: frame-1\n\n") // flushed before the stream closed - a buffering impl wouldn't have it
  expect(m.ended).toBe(false)
  close()
  await done
  expect(m.ended).toBe(true)
})

test("pipeWebBodyToNode streams all chunks in order, then ends", async () => {
  const m = mockRes()
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("a"))
      c.enqueue(enc.encode("b"))
      c.enqueue(enc.encode("c"))
      c.close()
    },
  })
  await pipeWebBodyToNode(body, m.res)
  expect(m.chunks).toEqual(["a", "b", "c"])
  expect(m.ended).toBe(true)
})

test("pipeWebBodyToNode ends immediately on a null body", async () => {
  const m = mockRes()
  await pipeWebBodyToNode(null, m.res)
  expect(m.ended).toBe(true)
  expect(m.chunks).toEqual([])
})

test("pipeWebBodyToNode cancels the reader when the client disconnects", async () => {
  const m = mockRes()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("x")) // never closes
    },
    cancel() {
      cancelled = true
    },
  })
  const done = pipeWebBodyToNode(body, m.res)
  await new Promise((r) => setTimeout(r, 10))
  m.triggerClose() // client hung up
  await done
  expect(cancelled).toBe(true)
})

// A Node response whose socket buffer is full: `write` says so until the test lets it drain.
function fullSink() {
  const sink = Object.assign(new EventEmitter(), {
    writes: 0,
    full: true,
    ended: false,
    write(_c: Uint8Array) {
      sink.writes++
      return !sink.full
    },
    end() {
      sink.ended = true
    },
  })
  return sink
}

const turns = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve))
}

test("pipeWebBodyToNode reads no further until a full socket drains", async () => {
  let pulls = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (pulls === 32) return c.close()
        pulls++
        c.enqueue(new Uint8Array(1024))
      },
    },
    { highWaterMark: 0 },
  )
  const sink = fullSink()
  const done = pipeWebBodyToNode(body, sink)
  await turns(10)
  expect([pulls, sink.writes, sink.ended]).toEqual([1, 1, false])
  sink.full = false
  sink.emit("drain")
  await done
  expect([pulls, sink.writes, sink.ended]).toEqual([32, 32, true])
  expect([sink.listenerCount("drain"), sink.listenerCount("close")]).toEqual([0, 0])
})

test("pipeWebBodyToNode ends and cancels the body when the client leaves during a full socket", async () => {
  let cancelled = false
  let pulls = 0
  const body = new ReadableStream<Uint8Array>(
    {
      // Bounded, so a pipe that ignores the full socket finishes (and fails) rather than spins.
      pull(c) {
        if (pulls === 32) return c.close()
        pulls++
        c.enqueue(new Uint8Array(1024))
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  const sink = fullSink()
  const done = pipeWebBodyToNode(body, sink)
  await turns(10)
  sink.emit("close")
  await done
  expect([cancelled, sink.writes, sink.ended]).toEqual([true, 1, true])
  expect([sink.listenerCount("drain"), sink.listenerCount("close")]).toEqual([0, 0])
})

test("pipeWebBodyToNode cancels the body of a client that left before piping began", async () => {
  // Node's response is destroyed and its `close` already fired; every write returns false.
  let cancelled = false
  let writes = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("data: x\n\n"))
    },
    cancel() {
      cancelled = true
    },
  })
  const res = {
    destroyed: true,
    on() {},
    once() {},
    off() {},
    write() {
      writes++
      return false
    },
    end() {},
  }
  const settled = await Promise.race([
    pipeWebBodyToNode(body, res).then(() => true),
    Bun.sleep(500).then(() => false),
  ])
  expect({ settled, cancelled, writes }).toEqual({ settled: true, cancelled: true, writes: 0 })
})

test("pipeWebBodyToNode stops at a write the destroyed response refuses", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x"))
    },
    cancel() {
      cancelled = true
    },
  })
  const res = {
    destroyed: false,
    on() {},
    once() {},
    off() {},
    write() {
      // The socket goes away as this write lands.
      res.destroyed = true
      return false
    },
    end() {},
  }
  const settled = await Promise.race([
    pipeWebBodyToNode(body, res).then(() => true),
    Bun.sleep(500).then(() => false),
  ])
  expect({ settled, cancelled }).toEqual({ settled: true, cancelled: true })
})
