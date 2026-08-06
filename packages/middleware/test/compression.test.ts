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
    expect(() => compression({ threshold: -1 })).toThrow(/threshold/)
    expect(() => compression({ threshold: 1.5 })).toThrow(/threshold/)
  })
})
