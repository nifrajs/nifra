import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { compression } from "@nifrajs/middleware"

const GZIP = { "accept-encoding": "gzip, deflate, br" }
const big = "x".repeat(2000) // > default 1024 threshold

const gunzip = (res: Response): Promise<string> => {
  if (res.body === null) throw new Error("no body")
  return new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text()
}

const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

/** An endless event stream, one event every 20ms; the first event's arrival shows nothing buffers it. */
function eventStream(headers: Record<string, string> = {}): Response {
  let n = 0
  let cancelled = false
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: (controller) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            if (!cancelled) controller.enqueue(new TextEncoder().encode(`data: ${n++}\n\n`))
            resolve()
          }, 20),
        ),
      cancel: () => {
        cancelled = true
      },
    }),
    { headers: { "content-type": "text/event-stream", ...headers } },
  )
}

async function firstChunk(response: Response, ms: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return "no body"
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("nothing arrived"), ms)
  })
  const first = reader.read().then((chunk) => new TextDecoder().decode(chunk.value))
  const outcome = await Promise.race([first, deadline]).finally(() => clearTimeout(timer))
  await reader.cancel()
  return outcome
}

describe("compression()", () => {
  test("gzips a framework-serialized body when the client accepts gzip (round-trips)", async () => {
    const app = server()
      .use(compression())
      .get("/", () => ({ data: big }))
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(res.headers.get("content-encoding")).toBe("gzip")
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept-encoding")
    expect(JSON.parse(await gunzip(res))).toEqual({ data: big }) // decompresses to the original
  })

  test("compresses a handler-returned raw streamed Response without buffering it", async () => {
    const app = server()
      .use(compression())
      .get("/", () => new Response(streamOf(big), { headers: { "content-type": "text/html" } }))
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(res.headers.get("content-encoding")).toBe("gzip")
    expect(await gunzip(res)).toBe(big)
  })

  test("a strong ETag is weakened on the compressed representation", async () => {
    const big = "x".repeat(4096)
    const app = server()
      .use(compression())
      .get("/strong", (c) => {
        c.set.headers.etag = '"v1"'
        return { big }
      })
      .get(
        "/raw",
        () => new Response(big, { headers: { "content-type": "text/plain", etag: '"v2"' } }),
      )
      .get(
        "/weak",
        () => new Response(big, { headers: { "content-type": "text/plain", etag: 'W/"v3"' } }),
      )
    const gzip = { headers: { "accept-encoding": "gzip" } }
    for (const [path, expected] of [
      ["/strong", 'W/"v1"'],
      ["/raw", 'W/"v2"'],
      ["/weak", 'W/"v3"'],
    ] as const) {
      const res = await app.fetch(new Request(`http://x${path}`, gzip))
      expect({
        path,
        encoding: res.headers.get("content-encoding"),
        etag: res.headers.get("etag"),
      }).toEqual({
        path,
        encoding: "gzip",
        etag: expected,
      })
    }
    const identity = await app.fetch(new Request("http://x/raw"))
    expect(identity.headers.get("etag")).toBe('"v2"')
  })

  test("an event stream without no-transform still passes through uncompressed", async () => {
    const app = server()
      .use(compression({ threshold: 1 }))
      .get("/events", () => eventStream())
    const response = await app.fetch(
      new Request("http://x/events", { headers: { "accept-encoding": "gzip" } }),
    )
    expect(response.headers.get("content-encoding")).toBeNull()
    expect(await firstChunk(response, 1000)).toBe("data: 0\n\n")
  })

  test("skips when the client does not accept gzip", async () => {
    const app = server()
      .use(compression())
      .get("/", () => new Response(big, { headers: { "content-type": "text/plain" } }))
    const res = await app.fetch(new Request("http://x/")) // no Accept-Encoding
    expect(res.headers.get("content-encoding")).toBeNull()
    expect(await res.text()).toBe(big)
  })

  test("honors an explicit gzip q=0 exclusion", async () => {
    const app = server()
      .use(compression())
      .get("/", () => ({ data: big }))
    const res = await app.fetch(
      new Request("http://x/", { headers: { "accept-encoding": "gzip;q=0, *;q=1" } }),
    )
    expect(res.headers.get("content-encoding")).toBeNull()
    expect(await res.json()).toEqual({ data: big })
  })

  test("skips non-compressible content types (already-compressed media)", async () => {
    const app = server()
      .use(compression())
      .get("/", () => new Response(big, { headers: { "content-type": "image/png" } }))
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(res.headers.get("content-encoding")).toBeNull()
  })

  test("skips bodies below the threshold (peeked - no Content-Length needed)", async () => {
    const app = server()
      .use(compression({ threshold: 1024 }))
      .get("/", () => new Response("tiny", { headers: { "content-type": "text/plain" } }))
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(res.headers.get("content-encoding")).toBeNull()
    expect(await res.text()).toBe("tiny") // emitted uncompressed, intact
  })

  test("skips via the Content-Length fast path when the length is declared and small", async () => {
    const app = server()
      .use(compression({ threshold: 1024 }))
      .get(
        "/",
        () =>
          new Response("declared-small", {
            headers: { "content-type": "text/plain", "content-length": "14" },
          }),
      )
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(res.headers.get("content-encoding")).toBeNull()
  })

  test("skips already-encoded responses", async () => {
    const app = server()
      .use(compression())
      .get(
        "/",
        () =>
          new Response(big, {
            headers: { "content-type": "text/plain", "content-encoding": "br" },
          }),
      )
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(res.headers.get("content-encoding")).toBe("br") // untouched
  })

  test("skips Range responses and no-transform", async () => {
    const range = server()
      .use(compression())
      .get("/", () => new Response(big, { status: 206, headers: { "content-type": "text/plain" } }))
    expect(
      (await range.fetch(new Request("http://x/", { headers: GZIP }))).headers.get(
        "content-encoding",
      ),
    ).toBeNull()

    const noTransform = server()
      .use(compression())
      .get(
        "/",
        () =>
          new Response(big, {
            headers: { "content-type": "text/plain", "cache-control": "no-transform" },
          }),
      )
    expect(
      (await noTransform.fetch(new Request("http://x/", { headers: GZIP }))).headers.get(
        "content-encoding",
      ),
    ).toBeNull()

    const similarDirective = server()
      .use(compression())
      .get(
        "/",
        () =>
          new Response(big, {
            headers: { "content-type": "text/plain", "cache-control": "x-no-transforming" },
          }),
      )
    expect(
      (await similarDirective.fetch(new Request("http://x/", { headers: GZIP }))).headers.get(
        "content-encoding",
      ),
    ).toBe("gzip")

    const frameworkNoTransform = server()
      .use(compression())
      .get("/", (c) => {
        c.set.headers["cache-control"] = "No-Transform"
        return { data: big }
      })
    expect(
      (await frameworkNoTransform.fetch(new Request("http://x/", { headers: GZIP }))).headers.get(
        "content-encoding",
      ),
    ).toBeNull()
  })

  test("skips bodyless responses (204) without throwing", async () => {
    const app = server()
      .use(compression())
      .get("/", () => new Response(null, { status: 204 }))
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(res.status).toBe(204)
    expect(res.headers.get("content-encoding")).toBeNull()
  })

  test("preserves an existing Vary header (merges, no duplicate)", async () => {
    const app = server()
      .use(compression())
      .get("/", (c) => {
        c.set.headers.vary = "Accept-Language"
        return { data: big }
      })
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    const vary = res.headers.get("vary")?.toLowerCase() ?? ""
    expect(vary).toContain("accept-language")
    expect(vary).toContain("accept-encoding")
  })

  test("does not duplicate a differently-cased Accept-Encoding Vary token", async () => {
    const app = server()
      .use(compression())
      .get(
        "/",
        () =>
          new Response(big, {
            headers: { "content-type": "text/plain", vary: "Accept-Encoding" },
          }),
      )
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    const tokens = res.headers
      .get("vary")
      ?.toLowerCase()
      .split(",")
      .filter((value) => value.trim() === "accept-encoding")
    expect(tokens).toHaveLength(1)
  })

  test("propagates a downstream cancel to the upstream reader (no leak on disconnect)", async () => {
    let cancelled = false
    const upstream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(big)) // keep producing past the threshold
      },
      cancel() {
        cancelled = true
      },
    })
    const app = server()
      .use(compression())
      .get("/", () => new Response(upstream, { headers: { "content-type": "text/html" } }))
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    await res.body?.cancel() // cancel the compressed (downstream) stream
    // Cancel propagates async through CompressionStream → pipeTo → source.cancel → reader.cancel.
    for (let i = 0; i < 50 && !cancelled; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(cancelled).toBe(true) // reached the upstream - no leaked reader on disconnect
  })

  test("honors a custom compressible predicate", async () => {
    const app = server()
      .use(compression({ compressible: (t) => t.startsWith("application/x-custom") }))
      .get("/", (c) => {
        c.set.headers["content-type"] = "application/x-custom"
        return { data: big }
      })
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(res.headers.get("content-encoding")).toBe("gzip")
  })

  test("validates the threshold", () => {
    expect(() => compression({ threshold: 1.5 })).toThrow(/threshold/)
    expect(() => compression({ threshold: -1 })).toThrow(/threshold/)
  })

  // An upstream that fails partway is the case the raw tier cannot buffer its way out of: the
  // prefix has already been consumed off the reader and cannot be pushed back. These cover the
  // replay path that hands that prefix (and the still-live reader) to the client unencoded.
  describe("upstream failure during the threshold peek", () => {
    // Emits `prefix`, then fails. With prefix under the threshold the failure lands inside the
    // peek loop, so compression has to abandon gzip and replay what it already took.
    const failsAfter = (prefix: string, error: Error): ReadableStream<Uint8Array> => {
      let sent = false
      return new ReadableStream({
        pull(controller) {
          if (sent) throw error
          sent = true
          controller.enqueue(new TextEncoder().encode(prefix))
        },
      })
    }

    test("replays the peeked prefix uncompressed when the upstream fails mid-peek", async () => {
      const app = server()
        .use(compression())
        .get(
          "/",
          () =>
            new Response(failsAfter("head", new Error("upstream failed")), {
              headers: { "content-type": "text/plain" },
            }),
        )
      const res = await app.fetch(new Request("http://x/", { headers: GZIP }))

      // Never claim an encoding for bytes that were never gzipped.
      expect(res.headers.get("content-encoding")).toBeNull()
      expect(res.status).toBe(200)

      // The prefix survives; the upstream's failure then surfaces rather than truncating silently.
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toBe("head")
      await expect(reader.read()).rejects.toThrow("upstream failed")
    })

    test("surfaces an upstream failure that arrives after the threshold is met", async () => {
      // The peek succeeds here, so the response IS gzipped - the failure has to travel through
      // CompressionStream instead of the replay path.
      const app = server()
        .use(compression())
        .get(
          "/",
          () =>
            new Response(failsAfter(big, new Error("upstream failed late")), {
              headers: { "content-type": "text/plain" },
            }),
        )
      const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
      expect(res.headers.get("content-encoding")).toBe("gzip")
      await expect(gunzip(res)).rejects.toThrow()
    })
  })
})
