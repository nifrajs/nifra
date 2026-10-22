import { describe, expect, test } from "bun:test"
import { constants, gunzipSync, gzipSync } from "node:zlib"
import { server } from "@nifrajs/core"
import { compression } from "@nifrajs/middleware"
import { gzipBuffered, gzipPlanFor } from "../src/compression.ts"

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

describe("buffered gzip lanes", () => {
  test("each runtime gets the lanes measured fastest for it", () => {
    const unbounded = Number.POSITIVE_INFINITY
    expect([gzipPlanFor({ Bun: {} }), gzipPlanFor({ Deno: {} }), gzipPlanFor({})]).toEqual([
      { inlineMax: 4096, oneShotMax: unbounded },
      { inlineMax: unbounded, oneShotMax: unbounded },
      { inlineMax: -1, oneShotMax: 8192 },
    ])
  })

  test("inline up to its cut, then one call, then CompressionStream", async () => {
    const calls: string[] = []
    const zlib = {
      gzipSync: (body: string | Uint8Array) => {
        calls.push(`sync ${body.length}`)
        return gzipSync(body)
      },
      gzip: (
        body: string | Uint8Array,
        done: (error: Error | null, result: Uint8Array) => void,
      ) => {
        calls.push(`one-shot ${body.length}`)
        done(null, gzipSync(body))
      },
    }
    const plan = { inlineMax: 2, oneShotMax: 4 }
    const inline = gzipBuffered("ab", plan, zlib)
    if (inline instanceof Promise)
      throw new Error("a body within inlineMax was gzipped off the loop")
    const results = [
      inline,
      await gzipBuffered("abcd", plan, zlib),
      await gzipBuffered("abcde", plan, zlib),
    ]
    expect(calls).toEqual(["sync 2", "one-shot 4"])
    expect(results.map((bytes) => gunzipSync(bytes).toString())).toEqual(["ab", "abcd", "abcde"])
    expect(gunzipSync(await gzipBuffered("abc", plan, undefined)).toString()).toBe("abc")
    const failing = {
      gzip: (_: unknown, done: (error: Error | null, result: Uint8Array) => void) =>
        done(new Error("zlib failed"), new Uint8Array()),
    }
    await expect(gzipBuffered("abc", plan, failing)).rejects.toThrow("zlib failed")
  })
})

describe("compression()", () => {
  test("on Cloudflare Workers it leaves every body to the platform", async () => {
    const agent = Object.getOwnPropertyDescriptor(globalThis.navigator, "userAgent")
    Object.defineProperty(globalThis.navigator, "userAgent", {
      value: "Cloudflare-Workers",
      configurable: true,
    })
    let plugin: ReturnType<typeof compression>
    try {
      plugin = compression()
    } finally {
      if (agent === undefined) Reflect.deleteProperty(globalThis.navigator, "userAgent")
      else Object.defineProperty(globalThis.navigator, "userAgent", agent)
    }
    const app = server()
      .use(plugin)
      .get("/", () => ({ data: big }))
      .get(
        "/stream",
        () => new Response(streamOf(big), { headers: { "content-type": "text/html" } }),
      )
    const buffered = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(buffered.headers.get("content-encoding")).toBeNull()
    expect(await buffered.json()).toEqual({ data: big })
    const streamed = await app.fetch(new Request("http://x/stream", { headers: GZIP }))
    expect(streamed.headers.get("content-encoding")).toBeNull()
    expect(await streamed.text()).toBe(big)
  })

  test("gzips a framework-serialized body when the client accepts gzip (round-trips)", async () => {
    const app = server()
      .use(compression())
      .get("/", () => ({ data: big }))
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(res.headers.get("content-encoding")).toBe("gzip")
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept-encoding")
    expect(JSON.parse(await gunzip(res))).toEqual({ data: big }) // decompresses to the original
  })

  test("a buffered body round-trips through every gzip lane", async () => {
    for (const data of ["é".repeat(2 * 1024), "é".repeat(64 * 1024)]) {
      const app = server()
        .use(compression())
        .get("/", () => ({ data }))
      const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
      expect(res.headers.get("content-encoding")).toBe("gzip")
      expect(JSON.parse(await gunzip(res))).toEqual({ data })
    }
  })

  test("a compressed c.text response is single-use and never replays another user's cookie", async () => {
    for (const network of [false, true]) {
      let shared: Response | undefined
      const app = server()
        .use(compression())
        .get("/", (c) => {
          shared ??= c.text(big)
          if (c.header("x-user") === "alice") c.set.cookie("sid", "alice-session")
          return shared
        })
      const running = network ? app.listen(0, { hostname: "127.0.0.1" }) : undefined
      const send = (user: string) => {
        const req = new Request(`http://127.0.0.1:${running?.port ?? 80}/`, {
          headers: { ...GZIP, "x-user": user },
        })
        return network ? fetch(req) : app.fetch(req)
      }
      try {
        const alice = await send("alice")
        expect(alice.headers.get("set-cookie")).toContain("sid=alice-session")
        expect(network ? await alice.text() : await gunzip(alice)).toBe(big)
        const bob = await send("bob")
        expect(bob.status).toBe(500)
        expect(bob.headers.getSetCookie()).toEqual([])
        expect(bob.headers.get("content-encoding")).toBeNull()
        expect(await bob.json()).toEqual({ ok: false, error: "internal_error" })
      } finally {
        if (running !== undefined) await app.stop()
      }
    }
  })

  test("compresses a handler-returned raw streamed Response without buffering it", async () => {
    const app = server()
      .use(compression())
      .get("/", () => new Response(streamOf(big), { headers: { "content-type": "text/html" } }))
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    expect(res.headers.get("content-encoding")).toBe("gzip")
    expect(await gunzip(res)).toBe(big)
  })

  test("a streamed body's compressed prefix reaches the client before the upstream ends", async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let sent = false
    const upstream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent) {
          await held
          controller.close()
          return
        }
        sent = true
        controller.enqueue(new TextEncoder().encode(`<!doctype html>${big}`))
      },
    })
    const app = server()
      .use(compression())
      .get("/", () => new Response(upstream, { headers: { "content-type": "text/html" } }))
    const res = await app.fetch(new Request("http://x/", { headers: GZIP }))
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error("no body")
    const received: Uint8Array[] = []
    let text = ""
    try {
      // The upstream is still open here; buffering until it closes would never decode the shell.
      while (!text.startsWith("<!doctype html>")) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("ended early")
        received.push(chunk.value)
        text = gunzipSync(Buffer.concat(received), {
          finishFlush: constants.Z_SYNC_FLUSH,
        }).toString()
      }
    } finally {
      release()
    }
    expect(text).toBe(`<!doctype html>${big}`)
    await reader.cancel()
  }, 5000)

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

  test("the identity representation of a compressible response varies on Accept-Encoding too", async () => {
    const app = server()
      .use(compression())
      .get("/json", () => ({ data: big }))
      .get("/raw", () => new Response(big, { headers: { "content-type": "text/plain" } }))
      .get(
        "/stream",
        () => new Response(streamOf(big), { headers: { "content-type": "text/plain" } }),
      )
      .get("/tiny", () => ({ data: "tiny" }))
      .get("/png", () => new Response(big, { headers: { "content-type": "image/png" } }))
    const vary = async (path: string, headers: Record<string, string> = {}) => {
      const res = await app.fetch(new Request(`http://x${path}`, { headers }))
      return { encoding: res.headers.get("content-encoding"), vary: res.headers.get("vary") }
    }
    for (const path of ["/json", "/raw", "/stream"]) {
      expect(await vary(path)).toEqual({ encoding: null, vary: "Accept-Encoding" })
      expect(await vary(path, GZIP)).toEqual({ encoding: "gzip", vary: "Accept-Encoding" })
    }
    // One representation for every client: nothing to vary on.
    for (const path of ["/tiny", "/png"]) {
      expect(await vary(path)).toEqual({ encoding: null, vary: null })
      expect(await vary(path, GZIP)).toEqual({ encoding: null, vary: null })
    }
  })

  test("a multi-byte body is measured in UTF-8 bytes against the threshold", async () => {
    // {"s":"..."}: 8 framing bytes plus 2 bytes per é - 36 and 38 bytes, either side of 37.
    const app = server()
      .use(compression({ threshold: 37 }))
      .get("/short", () => ({ s: "\u00e9".repeat(14) }))
      .get("/long", () => ({ s: "\u00e9".repeat(15) }))
    const encodingOf = async (path: string) =>
      (await app.fetch(new Request(`http://x${path}`, { headers: GZIP }))).headers.get(
        "content-encoding",
      )
    expect(await encodingOf("/short")).toBeNull()
    expect(await encodingOf("/long")).toBe("gzip")
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
