import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { createCsrfToken, csrf, verifyCsrfToken } from "../src/index.ts"

const SECRET = "0123456789abcdef0123456789abcdef"

function protectedApp() {
  return server()
    .use(csrf({ secret: SECRET }))
    .post("/mutate", () => ({ ok: true }))
}

describe("csrf()", () => {
  test("accepts same-origin signed double-submit tokens", async () => {
    const token = await createCsrfToken(SECRET)
    const res = await protectedApp().fetch(
      new Request("http://app.test/mutate", {
        method: "POST",
        headers: {
          origin: "http://app.test",
          cookie: `csrf-token=${encodeURIComponent(token)}`,
          "x-csrf-token": token,
        },
      }),
    )
    expect(res.status).toBe(200)
  })

  test("rejects missing Origin/Referer, cross-origin, missing token, mismatched token, and tampering", async () => {
    const token = await createCsrfToken(SECRET)
    const app = protectedApp()
    const baseHeaders = {
      origin: "http://app.test",
      cookie: `csrf-token=${encodeURIComponent(token)}`,
      "x-csrf-token": token,
    }

    const cases: Array<Record<string, string>> = [
      { cookie: baseHeaders.cookie, "x-csrf-token": token },
      { ...baseHeaders, origin: "http://evil.test" },
      { origin: "http://app.test", "x-csrf-token": token },
      { ...baseHeaders, "x-csrf-token": await createCsrfToken(SECRET) },
      { ...baseHeaders, "x-csrf-token": `${token.slice(0, -1)}x` },
    ]
    for (const headers of cases) {
      const res = await app.fetch(
        new Request("http://app.test/mutate", { method: "POST", headers }),
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ ok: false, error: "csrf_failed" })
    }
  })

  test("same-origin default survives a TLS-terminating proxy but never a downgrade or another host", async () => {
    const token = await createCsrfToken(SECRET)
    const app = protectedApp()
    const send = (url: string, origin: string) =>
      app.fetch(
        new Request(url, {
          method: "POST",
          headers: {
            origin,
            cookie: `csrf-token=${encodeURIComponent(token)}`,
            "x-csrf-token": token,
          },
        }),
      )
    // The proxy hands the server a plain-HTTP URL while the browser reports the https page.
    expect((await send("http://app.test/mutate", "https://app.test")).status).toBe(200)
    expect((await send("https://app.test/mutate", "http://app.test")).status).toBe(403)
    expect((await send("http://app.test/mutate", "https://evil.test")).status).toBe(403)
  })

  test("a configured form field carries the token for a plain HTML form; the body stays readable", async () => {
    const token = await createCsrfToken(SECRET)
    const app = server()
      .use(csrf({ secret: SECRET, field: "_csrf", fieldMaxBytes: 1024 }))
      .post("/mutate", async (c) => ({ body: await c.req.text() }))
    const post = (body: BodyInit, headers: Record<string, string> = {}) =>
      app.fetch(
        new Request("http://app.test/mutate", {
          method: "POST",
          headers: {
            origin: "http://app.test",
            cookie: `csrf-token=${encodeURIComponent(token)}`,
            ...headers,
          },
          body,
        }),
      )
    const urlencoded = { "content-type": "application/x-www-form-urlencoded" }

    const form = `name=x&_csrf=${encodeURIComponent(token)}`
    const ok = await post(form, urlencoded)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ body: form })

    const multipart = new FormData()
    multipart.set("_csrf", token)
    multipart.set("name", "x")
    expect((await post(multipart)).status).toBe(200)

    const rejected: Array<[BodyInit, Record<string, string>]> = [
      [`_csrf=${encodeURIComponent(await createCsrfToken(SECRET))}`, urlencoded], // not the cookie's
      [`_csrf=${encodeURIComponent(token)}`, { "content-type": "text/plain" }], // not a form
      [`_csrf=${encodeURIComponent(token)}&pad=${"x".repeat(2048)}`, urlencoded], // over the cap
      ["name=x", urlencoded], // no field
    ]
    for (const [body, headers] of rejected) expect((await post(body, headers)).status).toBe(403)

    // A file part under the field's name is not a token.
    const filePart = new FormData()
    filePart.set("_csrf", new Blob([token]), "token.txt")
    expect((await post(filePart)).status).toBe(403)

    // Without `field`, only the header counts.
    expect(
      (
        await protectedApp().fetch(
          new Request("http://app.test/mutate", {
            method: "POST",
            headers: {
              origin: "http://app.test",
              cookie: `csrf-token=${encodeURIComponent(token)}`,
              ...urlencoded,
            },
            body: form,
          }),
        )
      ).status,
    ).toBe(403)
    expect(() => csrf({ secret: SECRET, field: " " })).toThrow(/field/)
    expect(() => csrf({ secret: SECRET, field: "_csrf", fieldMaxBytes: 0 })).toThrow(
      /fieldMaxBytes/,
    )
  })

  test.each([
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=test",
  ])("rejects an oversized open %s stream without waiting for cancellation", async (contentType) => {
    let cancelled = false
    let handled = false
    let producer: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        producer = controller
        controller.enqueue(new Uint8Array(32))
        controller.enqueue(new Uint8Array(33))
      },
      cancel() {
        cancelled = true
        // A producer's cleanup may never settle; rejection must not wait for it either.
        return new Promise<void>(() => {})
      },
    })
    const app = server()
      .use(csrf({ secret: SECRET, field: "_csrf", fieldMaxBytes: 64 }))
      .post("/mutate", () => {
        handled = true
        return { ok: true }
      })
    const init = {
      method: "POST",
      headers: {
        origin: "http://app.test",
        cookie: "csrf-token=unsigned",
        "content-type": contentType,
      },
      body,
      duplex: "half" as const,
    }
    const response = app.fetch(new Request("http://app.test/mutate", init))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        response,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("CSRF rejection waited for the stream")), 500)
        }),
      ])
      expect(result.status).toBe(403)
      expect(await result.json()).toEqual({ ok: false, error: "csrf_failed" })
      expect(handled).toBe(false)
      expect(cancelled).toBe(true)
    } finally {
      clearTimeout(timer)
      if (!cancelled) producer?.close()
    }
  })

  test("safe methods pass without a token", async () => {
    const app = server()
      .use(csrf({ secret: SECRET }))
      .get("/", () => ({ ok: true }))
    expect((await app.fetch(new Request("http://x/"))).status).toBe(200)
  })

  test("accepts Referer fallback and rejects malformed Referer", async () => {
    const token = await createCsrfToken(SECRET)
    const app = protectedApp()
    const common = {
      cookie: `csrf-token=${encodeURIComponent(token)}`,
      "x-csrf-token": token,
    }
    const ok = await app.fetch(
      new Request("http://app.test/mutate", {
        method: "POST",
        headers: { ...common, referer: "http://app.test/form" },
      }),
    )
    expect(ok.status).toBe(200)

    const bad = await app.fetch(
      new Request("http://app.test/mutate", {
        method: "POST",
        headers: { ...common, referer: "not a url" },
      }),
    )
    expect(bad.status).toBe(403)
  })

  test("honors custom methods and explicit allowed origins", async () => {
    const token = await createCsrfToken(SECRET)
    const app = server()
      .use(csrf({ secret: SECRET, methods: ["DELETE"], origins: ["https://admin.test"] }))
      .post("/mutate", () => ({ post: true }))
      .delete("/mutate", () => ({ deleted: true }))

    expect(
      (await app.fetch(new Request("http://app.test/mutate", { method: "POST" }))).status,
    ).toBe(200)
    const ok = await app.fetch(
      new Request("http://app.test/mutate", {
        method: "DELETE",
        headers: {
          origin: "https://admin.test",
          cookie: `csrf-token=${encodeURIComponent(token)}`,
          "x-csrf-token": token,
        },
      }),
    )
    expect(ok.status).toBe(200)

    const blocked = await app.fetch(
      new Request("http://app.test/mutate", {
        method: "DELETE",
        headers: {
          origin: "https://other.test",
          cookie: `csrf-token=${encodeURIComponent(token)}`,
          "x-csrf-token": token,
        },
      }),
    )
    expect(blocked.status).toBe(403)
  })

  test("token helper verifies signatures and rejects weak secrets", async () => {
    const token = await createCsrfToken(SECRET, "abcdefghijklmnopqrstuv")
    expect(await verifyCsrfToken(token, SECRET)).toBe(true)
    expect(await verifyCsrfToken(`${token.slice(0, -1)}x`, SECRET)).toBe(false)
    // The 43-char signature's last char has 2 unused bits; a set bit is a non-canonical twin.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const twin = `${token.slice(0, -1)}${alphabet[alphabet.indexOf(token.at(-1) ?? "") | 1]}`
    expect(await verifyCsrfToken(twin, SECRET)).toBe(false)
    await expect(createCsrfToken("short")).rejects.toThrow(/secret/)
    await expect(createCsrfToken(SECRET, "short")).rejects.toThrow(/nonce/)
    expect(() => csrf({ secret: "short" })).toThrow(/secret/)
  })

  test("secret rotation: old tokens verify against the list, first secret signs new ones", async () => {
    const OLD = "old-csrf-secret-at-least-32-byte!"
    const NEW = "new-csrf-secret-at-least-32-byte!"
    const oldToken = await createCsrfToken(OLD, "abcdefghijklmnopqrstuv")

    expect(await verifyCsrfToken(oldToken, [NEW, OLD])).toBe(true)
    expect(await verifyCsrfToken(oldToken, [NEW])).toBe(false) // old secret dropped

    const newToken = await createCsrfToken([NEW, OLD], "abcdefghijklmnopqrstuv")
    expect(await verifyCsrfToken(newToken, NEW)).toBe(true) // signed by the first secret

    expect(() => csrf({ secret: [] })).toThrow(/cannot be empty/)
    expect(() => csrf({ secret: [NEW, "weak"] })).toThrow(/secret/) // floor holds per entry
  })
})
