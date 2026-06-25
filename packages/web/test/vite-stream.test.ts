import { expect, test } from "bun:test"
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
// waited for the whole stream to END — an open-ended SSE body never ends, hanging `nifra dev`.
test("pipeWebBodyToNode flushes each frame as it arrives — does NOT wait for the stream to end (SSE-safe)", async () => {
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
  expect(m.chunks).toContain("data: frame-1\n\n") // flushed before the stream closed — a buffering impl wouldn't have it
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
