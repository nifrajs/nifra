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

  test("isolation headers are opt-in and off by default", async () => {
    const app = server()
      .use(securityHeaders())
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("cross-origin-opener-policy")).toBeNull()
    expect(res.headers.get("cross-origin-embedder-policy")).toBeNull()
    expect(res.headers.get("cross-origin-resource-policy")).toBeNull()
    expect(res.headers.get("permissions-policy")).toBeNull()
  })

  test("COOP/COEP/CORP/Permissions-Policy when configured", async () => {
    const app = server()
      .use(
        securityHeaders({
          crossOriginOpenerPolicy: "same-origin",
          crossOriginEmbedderPolicy: "require-corp",
          crossOriginResourcePolicy: "same-site",
          permissionsPolicy: "camera=(), geolocation=()",
        }),
      )
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin")
    expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp")
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-site")
    expect(res.headers.get("permissions-policy")).toBe("camera=(), geolocation=()")
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
    // Bun never marks headers immutable, so simulate the Workers/Deno case: a real Response whose
    // headers throw on mutation. The portable header hook's Web adapter must fall back to
    // clone-and-set, not crash - and the original must stay untouched.
    const throwingHeaders = new Proxy(new Headers({ "x-up": "1" }), {
      get(target, prop) {
        if (prop === "set") {
          return () => {
            throw new TypeError("immutable headers")
          }
        }
        const v = Reflect.get(target, prop)
        return typeof v === "function" ? v.bind(target) : v
      },
    })
    const immutable = new Proxy(new Response(null, { status: 204 }), {
      get(target, prop) {
        if (prop === "headers") return throwingHeaders
        const v = Reflect.get(target, prop)
        return typeof v === "function" ? v.bind(target) : v
      },
    })
    const app = server({ logger: silentLogger })
      .use(securityHeaders())
      .get("/x", () => immutable)
    const out = await app.fetch(new Request("http://t/x"))
    expect(out.status).toBe(204)
    expect(out.headers.get("x-content-type-options")).toBe("nosniff")
    expect(out.headers.get("x-up")).toBe("1") // original headers carried over
  })
})
