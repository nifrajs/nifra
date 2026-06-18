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
    await expect(createCsrfToken("short")).rejects.toThrow(/secret/)
    await expect(createCsrfToken(SECRET, "short")).rejects.toThrow(/nonce/)
    expect(() => csrf({ secret: "short" })).toThrow(/secret/)
  })
})
