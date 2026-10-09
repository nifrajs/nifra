import { describe, expect, test } from "bun:test"
import { type SSEStream, sse } from "../src/server/sse.ts"

function ctx(signal?: AbortSignal): { req: Request } {
  return { req: new Request("http://test/", signal ? { signal } : undefined) }
}

async function readAll(res: Response): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += decoder.decode(value)
  }
  return out
}

describe("sse", () => {
  test("returns a text/event-stream response", () => {
    const res = sse(ctx(), (s) => s.close())
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(res.headers.get("cache-control")).toContain("no-cache")
  })

  test("formats data / event / id / retry / comment frames", async () => {
    const out = await readAll(
      sse(ctx(), (s) => {
        s.send({ data: "hello" })
        s.send({ event: "tick", id: "1", data: "world" })
        s.send({ retry: 3000 })
        s.send({ comment: "ping" })
      }),
    )
    expect(out).toContain("data: hello\n\n")
    expect(out).toContain("event: tick\nid: 1\ndata: world\n\n")
    expect(out).toContain("retry: 3000\n\n")
    expect(out).toContain(": ping\n\n")
  })

  test("multi-line data emits one data: line per line", async () => {
    const out = await readAll(sse(ctx(), (s) => s.send({ data: "a\nb\nc" })))
    expect(out).toBe("data: a\ndata: b\ndata: c\n\n")
  })

  test("strips CR/LF from event/id/comment (frame-injection guard)", async () => {
    const out = await readAll(
      sse(ctx(), (s) => s.send({ event: "evt\ndata: injected", id: "1\n2", data: "x" })),
    )
    expect(out).toContain("event: evtdata: injected\n") // the newline is gone, so it's not a frame
    expect(out).toContain("id: 12\n")
    expect(out).not.toContain("\ndata: injected\n") // no smuggled data line
  })

  test("retry is coerced to an integer", async () => {
    const out = await readAll(sse(ctx(), (s) => s.send({ retry: 1500.9 })))
    expect(out).toContain("retry: 1500\n")
  })

  test("the stream closes when run resolves", async () => {
    const out = await readAll(sse(ctx(), (s) => void s.send({ data: "once" })))
    expect(out).toBe("data: once\n\n") // readAll only returns once the stream ends
  })

  test("send after close is a no-op", async () => {
    const out = await readAll(
      sse(ctx(), (s) => {
        s.send({ data: "a" })
        s.close()
        s.send({ data: "b" })
      }),
    )
    expect(out).toBe("data: a\n\n")
  })

  test("client disconnect (req.signal) ends the stream and fires the producer's abort handler", async () => {
    const controller = new AbortController()
    let tornDown = false
    const res = sse(
      ctx(controller.signal),
      (s) =>
        new Promise<void>((resolve) => {
          s.signal.addEventListener(
            "abort",
            () => {
              tornDown = true
              resolve()
            },
            { once: true },
          )
        }),
    )
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    controller.abort()
    const { done } = await reader.read()
    expect(done).toBe(true)
    expect(tornDown).toBe(true)
  })

  test("a body the runtime cancels aborts the producer's signal, even when the request signal never fires", async () => {
    let aborted = false
    const res = sse(ctx(), (s) => {
      s.signal.addEventListener("abort", () => {
        aborted = true
      })
      return new Promise<void>((resolve) => s.signal.addEventListener("abort", () => resolve()))
    })
    await res.body?.cancel()
    expect(aborted).toBe(true)
  })

  test("an already-aborted request never invokes run and closes immediately", async () => {
    const controller = new AbortController()
    controller.abort()
    let ran = false
    const out = await readAll(
      sse(ctx(controller.signal), (s) => {
        ran = true
        s.send({ data: "x" })
      }),
    )
    expect(ran).toBe(false)
    expect(out).toBe("")
  })

  test("a producer error propagates to the stream consumer", async () => {
    const res = sse(ctx(), () => {
      throw new Error("boom")
    })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await expect(reader.read()).rejects.toThrow("boom")
  })

  test("keepAlive emits comment pings", async () => {
    const res = sse(ctx(), () => new Promise<void>(() => {}), { keepAlive: 5 })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe(": \n\n")
    await reader.cancel() // stop the never-resolving producer + its interval
  })
})

describe("sse maxBufferedBytes", () => {
  const frame = { data: "x".repeat(1000) } // 1008 bytes on the wire

  // Sends without reading until the stream drops the client, at most `limit` times.
  function flood(init: Parameters<typeof sse>[2], limit: number) {
    let stream!: SSEStream
    const res = sse(
      ctx(),
      (s) => {
        stream = s
        return new Promise<void>(() => {})
      },
      init,
    )
    let sends = 0
    while (sends < limit && !stream.signal.aborted) {
      stream.send(frame)
      sends++
    }
    return { res, stream, sends }
  }

  test("a client that stops reading is dropped on the first send past the cap", async () => {
    const { res, stream, sends } = flood({ maxBufferedBytes: 4096 }, 1000)
    expect(sends).toBe(6)
    expect(String(stream.signal.reason)).toContain("sse_client_too_slow")
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await expect(reader.read()).rejects.toThrow("sse_client_too_slow")
  })

  test("the default cap is 1 MiB; Infinity turns it off", () => {
    expect(flood(undefined, 2000).sends).toBe(Math.ceil((1024 * 1024) / 1008) + 1)
    const unlimited = flood({ maxBufferedBytes: Number.POSITIVE_INFINITY }, 2000)
    expect(unlimited.sends).toBe(2000)
    expect(unlimited.stream.signal.aborted).toBe(false)
  })

  test("a reader that keeps up is never dropped, however much passes through", async () => {
    let caughtUp: (() => void) | undefined
    const res = sse(
      ctx(),
      async (s) => {
        for (let round = 0; round < 200; round++) {
          s.send(frame)
          s.send(frame)
          s.send(frame)
          await new Promise<void>((resolve) => {
            caughtUp = resolve
          })
        }
      },
      { maxBufferedBytes: 4096 },
    )
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    let bytes = 0
    let reads = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (++reads % 3 === 0) caughtUp?.()
    }
    expect(bytes).toBe(200 * 3 * 1008)
  })

  test("one frame larger than the cap still goes out to a reader that is caught up", async () => {
    const out = await readAll(sse(ctx(), (s) => s.send(frame), { maxBufferedBytes: 16 }))
    expect(out).toBe(`data: ${frame.data}\n\n`)
  })

  test("a negative, NaN, or non-numeric cap throws", () => {
    for (const maxBufferedBytes of [-1, Number.NaN, "1mb" as unknown as number])
      expect(() => sse(ctx(), () => {}, { maxBufferedBytes })).toThrow(RangeError)
  })
})
