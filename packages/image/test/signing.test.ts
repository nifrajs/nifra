import { describe, expect, test } from "bun:test"
import { selfHostedLoader, signImageUrl } from "@nifrajs/image"
import type { ImageBackend } from "@nifrajs/image/backends"
import { createImageHandler } from "@nifrajs/image/server"
import { signImageParams } from "../src/sign.ts"

const SECRET = "image-signing-secret_padded_32byt"

// A trivial stub backend + a fake remote source, so a *valid* signed request can run end-to-end.
const backend: ImageBackend = {
  async probe() {
    return { width: 200, height: 100, format: "png" }
  },
  async transform(input) {
    return { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", format: input.format }
  },
}
const fetchImpl = (async () =>
  new Response(new Uint8Array([0, 1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/png" },
  })) as unknown as typeof fetch

const handler = createImageHandler({
  signing: { secret: SECRET },
  backend,
  allowedOrigins: ["https://cdn.test"],
  fetch: fetchImpl,
})

const SRC = "https://cdn.test/a.png"
const req = (path: string) => new Request(`http://host${path}`)

describe("signed-URL enforcement", () => {
  test("accepts a URL the loader signed (same secret) end-to-end", async () => {
    const loader = selfHostedLoader({ endpoint: "/_image", secret: SECRET })
    const url = loader({ src: SRC, width: 50, quality: 80 })
    expect(url).toContain("&s=")
    const res = await handler(req(url))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
  })

  test("rejects a missing signature with 403", async () => {
    const unsigned = selfHostedLoader({ endpoint: "/_image" })({ src: SRC, width: 50 })
    const res = await handler(req(unsigned))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "invalid_signature" })
  })

  test("rejects a tampered width (signature no longer matches)", async () => {
    const loader = selfHostedLoader({ endpoint: "/_image", secret: SECRET })
    const url = loader({ src: SRC, width: 50 })
    const tampered = url.replace("w=50", "w=1600") // attacker bumps the width
    expect((await handler(req(tampered))).status).toBe(403)
  })

  test("rejects an expired signed URL (exp in the past)", async () => {
    const past = Math.floor(Date.now() / 1000) - 10
    const sig = signImageParams(SECRET, { src: SRC, w: "50", exp: String(past) })
    const url = `/_image?src=${encodeURIComponent(SRC)}&w=50&exp=${past}&s=${sig}`
    expect((await handler(req(url))).status).toBe(403)
  })

  test("signImageUrl mints a URL the handler accepts (with a future expiry)", async () => {
    const url = signImageUrl("/_image", { src: SRC, width: 50 }, { secret: SECRET, expiresIn: 300 })
    expect(url).toContain("exp=")
    expect((await handler(req(url))).status).toBe(200)
  })

  test("an unsigned handler ignores signatures (opt-in only)", async () => {
    const open = createImageHandler({
      backend,
      allowedOrigins: ["https://cdn.test"],
      fetch: fetchImpl,
    })
    const url = selfHostedLoader({ endpoint: "/_image" })({ src: SRC, width: 50 })
    expect((await open(req(url))).status).toBe(200)
  })
})
