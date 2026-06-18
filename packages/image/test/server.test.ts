import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import {
  bunImageBackend,
  createImageHandler,
  type ImageBackend,
  type ImageProbe,
  ImageProcessingError,
  type ResizeInput,
} from "../src/server.ts"

// --- helpers --------------------------------------------------------------

/** A controllable stub backend: canned probe + instrumented transform (records calls + tracks peak
 * concurrency), so the handler's security/policy logic is exercised without a real codec. */
function makeStub(
  config: {
    probe?: ImageProbe | (() => Promise<ImageProbe>)
    gate?: Promise<void>
    transformError?: unknown
  } = {},
) {
  const transformCalls: ResizeInput[] = []
  let inFlight = 0
  let peak = 0
  const backend: ImageBackend = {
    async probe() {
      const p = config.probe ?? { width: 100, height: 80, format: "png" }
      return typeof p === "function" ? p() : p
    },
    async transform(input) {
      transformCalls.push(input)
      inFlight++
      peak = Math.max(peak, inFlight)
      try {
        if (config.gate) await config.gate
        if (config.transformError) throw config.transformError
        return {
          bytes: new Uint8Array([1, 2, 3]),
          contentType: `image/${input.format}`,
          format: input.format,
        }
      } finally {
        inFlight--
      }
    },
  }
  return {
    backend,
    transformCalls,
    get peak() {
      return peak
    },
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function get(src: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost/_image?${src}`, init)
}

function crc32(buf: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type)
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, data.length)
  const body = new Uint8Array(t.length + data.length)
  body.set(t)
  body.set(data, t.length)
  const crc = new Uint8Array(4)
  new DataView(crc.buffer).setUint32(0, crc32(body))
  return new Uint8Array([...len, ...body, ...crc])
}

/** Build a valid RGBA PNG of `w`×`h` (zlib IDAT via node:zlib — Bun.deflateSync emits raw deflate).
 * `declaredW`/`declaredH` override the IHDR dimensions (with a correct CRC) while still emitting only
 * `w`×`h` real pixels — used to forge a decompression bomb that `metadata()` rejects on pixel count. */
function makePng(w: number, h: number, declaredW = w, declaredH = h): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, declaredW)
  dv.setUint32(4, declaredH)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = new Uint8Array(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4)
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 4
      raw[p] = 200
      raw[p + 1] = 50
      raw[p + 2] = 50
      raw[p + 3] = 255
    }
  }
  const idat = new Uint8Array(deflateSync(raw))
  return new Uint8Array([
    ...sig,
    ...pngChunk("IHDR", ihdr),
    ...pngChunk("IDAT", idat),
    ...pngChunk("IEND", new Uint8Array(0)),
  ])
}

const tmpRoots: string[] = []
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nifra-img-"))
  tmpRoots.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(tmpRoots.map((d) => rm(d, { recursive: true, force: true })))
})

// --- method + query validation -------------------------------------------

describe("request validation", () => {
  test("non-GET/HEAD → 405 with Allow", async () => {
    const h = createImageHandler({ backend: makeStub().backend, root: "/tmp" })
    const res = await h(new Request("http://localhost/_image?src=/a.png&w=10", { method: "POST" }))
    expect(res.status).toBe(405)
    expect(res.headers.get("Allow")).toBe("GET, HEAD")
  })

  test("missing / empty / over-long src → 400", async () => {
    const h = createImageHandler({ backend: makeStub().backend, root: "/tmp" })
    expect((await h(get("w=10"))).status).toBe(400)
    expect((await h(get("src=&w=10"))).status).toBe(400)
    expect((await h(get(`src=${"a".repeat(3000)}&w=10`))).status).toBe(400)
  })

  test("invalid width (missing, zero, negative, decimal, non-numeric) → 400", async () => {
    const h = createImageHandler({ backend: makeStub().backend, root: "/tmp" })
    for (const w of ["", "w=0", "w=-5", "w=1.5", "w=abc", "w=1e3", "w=0x10", "w=%2010"]) {
      expect((await h(get(`src=/a.png&${w}`))).status).toBe(400)
    }
  })

  test("invalid quality → 400; q>100 clamps to 100; absent uses default", async () => {
    const stub = makeStub()
    const h = createImageHandler({ backend: stub.backend, root: "/tmp", defaultQuality: 75 })
    // We need a real file for a 200; use a temp root.
    const root = await tempRoot()
    await writeFile(join(root, "a.png"), makePng(4, 4))
    const h2 = createImageHandler({ backend: stub.backend, root })
    expect((await h(get("src=/a.png&w=10&q=abc"))).status).toBe(400)
    expect((await h(get("src=/a.png&w=10&q=0"))).status).toBe(400)
    await h2(get("src=/a.png&w=10&q=300"))
    expect(stub.transformCalls.at(-1)?.quality).toBe(100)
    await h2(get("src=/a.png&w=10"))
    expect(stub.transformCalls.at(-1)?.quality).toBe(75)
  })

  test("width clamps to maxWidth", async () => {
    // Tall enough intrinsic width that maxWidth (not no-upscale) is the binding clamp; height kept
    // small so the source stays under the default pixel cap.
    const stub = makeStub({ probe: { width: 9999, height: 10, format: "png" } })
    const root = await tempRoot()
    await writeFile(join(root, "a.png"), makePng(4, 4))
    const h = createImageHandler({ backend: stub.backend, root, maxWidth: 1000 })
    await h(get("src=/a.png&w=5000"))
    expect(stub.transformCalls.at(-1)?.width).toBe(1000)
  })
})

// --- SSRF: local path resolution ------------------------------------------

describe("local source SSRF guards", () => {
  test("path traversal is rejected (403), valid file served (200), missing file 404", async () => {
    const root = await tempRoot()
    await writeFile(join(root, "hero.png"), makePng(4, 4))
    const stub = makeStub()
    const h = createImageHandler({ backend: stub.backend, root })

    expect((await h(get("src=/hero.png&w=10"))).status).toBe(200)
    expect((await h(get("src=/../../../etc/passwd&w=10"))).status).toBe(403)
    expect((await h(get("src=/..%2f..%2fetc%2fpasswd&w=10"))).status).toBe(403)
    expect((await h(get("src=/nope.png&w=10"))).status).toBe(404)
  })

  test("local sources disabled when no root configured → 403", async () => {
    const h = createImageHandler({ backend: makeStub().backend })
    expect((await h(get("src=/hero.png&w=10"))).status).toBe(403)
  })

  test("null byte in src → 400", async () => {
    const root = await tempRoot()
    const h = createImageHandler({ backend: makeStub().backend, root })
    expect((await h(get("src=/a%00.png&w=10"))).status).toBe(400)
  })

  test("protocol-relative //evil is treated as a (non-existent) local path, never fetched", async () => {
    const root = await tempRoot()
    const stub = makeStub()
    const h = createImageHandler({
      backend: stub.backend,
      root,
      allowedOrigins: ["https://evil.com"],
    })
    // //evil.com/x.png parses as a URL only with a base; standalone it is a relative path → local →
    // resolves under root → not found. Crucially it does NOT hit the network.
    const res = await h(get("src=//evil.com/x.png&w=10"))
    expect(res.status).toBe(404)
    expect(stub.transformCalls.length).toBe(0)
  })

  test("file inside root that symlinks outside → 403", async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    await writeFile(join(outside, "secret.png"), makePng(4, 4))
    await symlink(join(outside, "secret.png"), join(root, "link.png"))
    const h = createImageHandler({ backend: makeStub().backend, root })
    expect((await h(get("src=/link.png&w=10"))).status).toBe(403)
  })

  test("source exceeding maxSourceBytes (on disk) → 413", async () => {
    const root = await tempRoot()
    await writeFile(join(root, "big.png"), new Uint8Array(5000))
    const h = createImageHandler({ backend: makeStub().backend, root, maxSourceBytes: 1000 })
    expect((await h(get("src=/big.png&w=10"))).status).toBe(413)
  })
})

// --- SSRF: remote allowlist ------------------------------------------------

describe("remote source SSRF guards", () => {
  const png = makePng(4, 4)
  const okFetch = (async () =>
    new Response(png, {
      status: 200,
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch

  test("remote disabled by default (empty allowlist) → 403", async () => {
    const h = createImageHandler({ backend: makeStub().backend, fetch: okFetch })
    expect((await h(get("src=https%3A%2F%2Fcdn.example%2Fa.png&w=10"))).status).toBe(403)
  })

  test("origin not on allowlist → 403", async () => {
    const h = createImageHandler({
      backend: makeStub().backend,
      allowedOrigins: ["https://cdn.example"],
      fetch: okFetch,
    })
    expect((await h(get("src=https%3A%2F%2Fevil.example%2Fa.png&w=10"))).status).toBe(403)
  })

  test("non-http(s) schemes → 400 (file:, data:)", async () => {
    const h = createImageHandler({
      backend: makeStub().backend,
      allowedOrigins: ["https://cdn.example"],
      fetch: okFetch,
    })
    expect((await h(get("src=file%3A%2F%2F%2Fetc%2Fpasswd&w=10"))).status).toBe(400)
    expect((await h(get("src=data%3Atext%2Fhtml%2C%3Cx%3E&w=10"))).status).toBe(400)
  })

  test("allowed origin → fetched + served (200)", async () => {
    const stub = makeStub()
    const h = createImageHandler({
      backend: stub.backend,
      allowedOrigins: ["https://cdn.example"],
      fetch: okFetch,
    })
    expect((await h(get("src=https%3A%2F%2Fcdn.example%2Fa.png&w=10"))).status).toBe(200)
    expect(stub.transformCalls.length).toBe(1)
  })

  test("upstream non-2xx → 502", async () => {
    const fail = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    const h = createImageHandler({
      backend: makeStub().backend,
      allowedOrigins: ["https://cdn.example"],
      fetch: fail,
    })
    expect((await h(get("src=https%3A%2F%2Fcdn.example%2Fa.png&w=10"))).status).toBe(502)
  })

  test("upstream timeout → 504; other fetch error → 502", async () => {
    const timeout = (async () => {
      const e = new Error("timed out")
      e.name = "TimeoutError"
      throw e
    }) as unknown as typeof fetch
    const refused = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const mk = (f: typeof fetch) =>
      createImageHandler({
        backend: makeStub().backend,
        allowedOrigins: ["https://cdn.example"],
        fetch: f,
      })
    expect((await mk(timeout)(get("src=https%3A%2F%2Fcdn.example%2Fa.png&w=10"))).status).toBe(504)
    expect((await mk(refused)(get("src=https%3A%2F%2Fcdn.example%2Fa.png&w=10"))).status).toBe(502)
  })

  test("remote body over cap → 413 (declared Content-Length AND streamed-without-CL)", async () => {
    const declared = (async () =>
      new Response(new Uint8Array(10), {
        status: 200,
        headers: { "content-length": "999999999" },
      })) as unknown as typeof fetch
    const streamed = (async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(2000))
            c.close()
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const mk = (f: typeof fetch) =>
      createImageHandler({
        backend: makeStub().backend,
        allowedOrigins: ["https://cdn.example"],
        maxSourceBytes: 1000,
        fetch: f,
      })
    expect((await mk(declared)(get("src=https%3A%2F%2Fcdn.example%2Fa.png&w=10"))).status).toBe(413)
    expect((await mk(streamed)(get("src=https%3A%2F%2Fcdn.example%2Fa.png&w=10"))).status).toBe(413)
  })
})

// --- transform policy: format negotiation, no-upscale, pixel cap, errors ---

describe("transform policy", () => {
  async function rootWith(name: string, bytes = makePng(4, 4)): Promise<string> {
    const root = await tempRoot()
    await writeFile(join(root, name), bytes)
    return root
  }

  test("Accept: image/webp → webp; otherwise preserve png/jpeg source", async () => {
    const root = await rootWith("a.png")
    const png = makeStub({ probe: { width: 100, height: 100, format: "png" } })
    const jpeg = makeStub({ probe: { width: 100, height: 100, format: "jpeg" } })

    const hP = createImageHandler({ backend: png.backend, root })
    await hP(get("src=/a.png&w=10", { headers: { accept: "image/avif,image/webp,*/*" } }))
    expect(png.transformCalls.at(-1)?.format).toBe("webp")
    await hP(get("src=/a.png&w=10", { headers: { accept: "image/*" } }))
    expect(png.transformCalls.at(-1)?.format).toBe("png")

    const hJ = createImageHandler({ backend: jpeg.backend, root })
    await hJ(get("src=/a.png&w=10", { headers: { accept: "image/*" } }))
    expect(jpeg.transformCalls.at(-1)?.format).toBe("jpeg")
  })

  test("never upscales: requested width above intrinsic clamps to intrinsic", async () => {
    const root = await rootWith("a.png")
    const stub = makeStub({ probe: { width: 320, height: 240, format: "png" } })
    const h = createImageHandler({ backend: stub.backend, root })
    await h(get("src=/a.png&w=1000"))
    expect(stub.transformCalls.at(-1)?.width).toBe(320)
    await h(get("src=/a.png&w=100"))
    expect(stub.transformCalls.at(-1)?.width).toBe(100)
  })

  test("source over maxSourcePixels → 413 (decompression-bomb guard)", async () => {
    const root = await rootWith("a.png")
    const stub = makeStub({ probe: { width: 20000, height: 20000, format: "png" } })
    const h = createImageHandler({ backend: stub.backend, root, maxSourcePixels: 40_000_000 })
    const res = await h(get("src=/a.png&w=100"))
    expect(res.status).toBe(413)
    expect(stub.transformCalls.length).toBe(0)
  })

  test("ImageProcessingError maps to status; unknown throw → 500 (no leak)", async () => {
    const root = await rootWith("a.png")
    const mk = (err: unknown) =>
      createImageHandler({ backend: makeStub({ transformError: err }).backend, root })
    expect((await mk(new ImageProcessingError("decode", "x"))(get("src=/a.png&w=10"))).status).toBe(
      415,
    )
    expect(
      (await mk(new ImageProcessingError("too_large", "x"))(get("src=/a.png&w=10"))).status,
    ).toBe(413)
    expect(
      (await mk(new ImageProcessingError("unsupported", "x"))(get("src=/a.png&w=10"))).status,
    ).toBe(415)
    const res = await mk(new Error("kaboom: /secret/path leak"))(get("src=/a.png&w=10"))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("secret")
  })
})

// --- caching: headers, conditional requests, HEAD -------------------------

describe("caching", () => {
  async function root(): Promise<string> {
    const r = await tempRoot()
    await writeFile(join(r, "a.png"), makePng(4, 4))
    return r
  }

  test("200 sets immutable Cache-Control + Vary + ETag + Content-Type/Length", async () => {
    const h = createImageHandler({
      backend: makeStub().backend,
      root: await root(),
      cacheMaxAge: 600,
    })
    const res = await h(get("src=/a.png&w=10", { headers: { accept: "image/webp" } }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600, immutable")
    expect(res.headers.get("Vary")).toBe("Accept")
    expect(res.headers.get("Content-Type")).toBe("image/webp")
    expect(res.headers.get("Content-Length")).toBe("3")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]+"$/)
  })

  test("If-None-Match with the ETag → 304 and short-circuits the backend (no transform)", async () => {
    const stub = makeStub()
    const h = createImageHandler({ backend: stub.backend, root: await root() })
    const first = await h(get("src=/a.png&w=10"))
    const etag = first.headers.get("ETag")!
    expect(stub.transformCalls.length).toBe(1)
    const res = await h(get("src=/a.png&w=10", { headers: { "if-none-match": etag } }))
    expect(res.status).toBe(304)
    expect(res.headers.get("ETag")).toBe(etag)
    expect(await res.text()).toBe("")
    expect(stub.transformCalls.length).toBe(1) // unchanged — no second transform
  })

  test("ETag varies by Accept (webp vs not), width, and quality", async () => {
    const h = createImageHandler({ backend: makeStub().backend, root: await root() })
    const e = async (qs: string, accept?: string) =>
      (await h(get(qs, accept ? { headers: { accept } } : {}))).headers.get("ETag")
    const webp = await e("src=/a.png&w=10", "image/webp")
    const noWebp = await e("src=/a.png&w=10", "image/png")
    const wideW = await e("src=/a.png&w=20", "image/webp")
    const lowQ = await e("src=/a.png&w=10&q=40", "image/webp")
    expect(new Set([webp, noWebp, wideW, lowQ]).size).toBe(4)
  })

  test("HEAD → 200 with headers, empty body", async () => {
    const h = createImageHandler({ backend: makeStub().backend, root: await root() })
    const res = await h(get("src=/a.png&w=10", { method: "HEAD" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Length")).toBe("3")
    expect(await res.text()).toBe("")
  })
})

// --- concurrency -----------------------------------------------------------

describe("concurrency", () => {
  test("at most `concurrency` transforms run at once; excess queues", async () => {
    const gate = deferred()
    const stub = makeStub({ gate: gate.promise })
    const root = await tempRoot()
    await writeFile(join(root, "a.png"), makePng(4, 4))
    const h = createImageHandler({ backend: stub.backend, root, concurrency: 2 })
    const reqs = Array.from({ length: 5 }, () => h(get("src=/a.png&w=10")))
    await Bun.sleep(20) // let everything that can start, start
    expect(stub.peak).toBeLessThanOrEqual(2)
    gate.resolve()
    const all = await Promise.all(reqs)
    expect(all.every((r) => r.status === 200)).toBe(true)
    expect(stub.transformCalls.length).toBe(5)
    expect(stub.peak).toBe(2)
  })
})

// --- real Bun.Image backend ------------------------------------------------

describe("bunImageBackend (real Bun.Image)", () => {
  const backend = bunImageBackend()

  test("probe reads intrinsic dims + format without full decode", async () => {
    const probe = await backend.probe(makePng(120, 80))
    expect(probe).toEqual({ width: 120, height: 80, format: "png" })
  })

  test("transform resizes (aspect-preserving) + encodes to webp/jpeg/png", async () => {
    const src = makePng(120, 80)
    for (const format of ["webp", "jpeg", "png"] as const) {
      const out = await backend.transform({ bytes: src, width: 60, quality: 80, format })
      expect(out.format).toBe(format)
      expect(out.contentType).toBe(`image/${format}`)
      const md = await backend.probe(out.bytes) // round-trip decode the output
      expect(md.width).toBe(60)
      expect(md.height).toBe(40)
      expect(md.format).toBe(format)
    }
  })

  test("non-image input → ImageProcessingError(decode)", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    await expect(backend.probe(garbage)).rejects.toBeInstanceOf(ImageProcessingError)
    await expect(
      backend.transform({ bytes: garbage, width: 10, quality: 80, format: "webp" }),
    ).rejects.toMatchObject({ kind: "decode" })
  })

  test("declared decompression bomb → ImageProcessingError(too_large)", async () => {
    // IHDR declares 60000×60000 (valid CRC) but only 2×2 real pixels — Bun.Image rejects at
    // metadata() time on the pixel count, before touching the IDAT.
    const bomb = makePng(2, 2, 60000, 60000)
    await expect(backend.probe(bomb)).rejects.toMatchObject({ kind: "too_large" })
  })

  test("end-to-end via createImageHandler: local PNG → resized webp at clamped width", async () => {
    const root = await tempRoot()
    await writeFile(join(root, "photo.png"), makePng(200, 100))
    const h = createImageHandler({ root }) // default = bunImageBackend
    const res = await h(get("src=/photo.png&w=80", { headers: { accept: "image/webp" } }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/webp")
    const out = new Uint8Array(await res.arrayBuffer())
    const md = await backend.probe(out)
    expect(md).toEqual({ width: 80, height: 40, format: "webp" })
  })
})
