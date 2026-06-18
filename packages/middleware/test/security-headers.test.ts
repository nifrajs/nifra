import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "@nifrajs/core"
import { securityHeaders } from "../src/index.ts"

describe("securityHeaders", () => {
  test("sets safe defaults; HSTS and CSP are opt-in", async () => {
    const app = server()
      .use(securityHeaders())
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("x-frame-options")).toBe("DENY")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    expect(res.headers.get("strict-transport-security")).toBeNull()
    expect(res.headers.get("content-security-policy")).toBeNull()
  })

  test("HSTS with includeSubDomains + preload", async () => {
    const app = server()
      .use(
        securityHeaders({ hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true } }),
      )
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains; preload",
    )
  })

  test("HSTS minimal (max-age only)", async () => {
    const app = server()
      .use(securityHeaders({ hsts: { maxAge: 100 } }))
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("strict-transport-security")).toBe("max-age=100")
  })

  test("custom CSP, frame-options, referrer-policy", async () => {
    const app = server()
      .use(
        securityHeaders({
          contentSecurityPolicy: "default-src 'self'",
          frameOptions: "SAMEORIGIN",
          referrerPolicy: "strict-origin-when-cross-origin",
        }),
      )
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'")
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
  })

  test("headers land on a 500 too", async () => {
    const app = server({ logger: silentLogger })
      .use(securityHeaders())
      .get("/boom", () => {
        throw new Error("x")
      })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(500)
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("immutable-headers Response (proxied fetch on spec-correct runtimes) takes the clone path", async () => {
    // Bun never marks headers immutable, so simulate the Workers/Deno case: a Response-like whose
    // headers throw on mutation. The middleware must fall back to clone-and-set, not crash.
    const immutable = {
      body: null,
      status: 204,
      statusText: "No Content",
      headers: new Proxy(new Headers({ "x-up": "1" }), {
        get(target, prop) {
          if (prop === "set") {
            return () => {
              throw new TypeError("immutable headers")
            }
          }
          const v = Reflect.get(target, prop)
          return typeof v === "function" ? v.bind(target) : v
        },
      }),
    } as unknown as Response
    const mw = securityHeaders()
    const out = await mw.onResponse?.(immutable, new Request("http://x/"))
    expect(out).toBeDefined()
    expect(out).not.toBe(immutable) // cloned, not mutated
    expect((out as Response).status).toBe(204)
    expect((out as Response).headers.get("x-content-type-options")).toBe("nosniff")
    expect((out as Response).headers.get("x-up")).toBe("1") // original headers carried over
  })
})
