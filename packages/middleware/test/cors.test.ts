import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "@nifrajs/core"
import { cors } from "../src/index.ts"

const origin = (value: string) => ({ headers: { origin: value } })

describe("cors", () => {
  test("adds Allow-Origin: * by default", async () => {
    const app = server()
      .use(cors())
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/", origin("https://app.com")))
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
    // `*` should not advertise Vary: Origin.
    expect(res.headers.get("vary")).toBeNull()
  })

  test("handles preflight with 204 + method/header/max-age advertisements", async () => {
    const app = server()
      .use(cors({ maxAge: 600 }))
      .get("/", () => "ok")
    const res = await app.fetch(
      new Request("http://x/", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-methods")).toContain("POST")
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type")
    expect(res.headers.get("access-control-max-age")).toBe("600")
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
  })

  test("preflight without requested headers omits Allow-Headers", async () => {
    const app = server()
      .use(cors())
      .get("/", () => "ok")
    const res = await app.fetch(
      new Request("http://x/", {
        method: "OPTIONS",
        headers: { origin: "https://a.com", "access-control-request-method": "GET" },
      }),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-headers")).toBeNull()
  })

  test("explicit allowedHeaders override the reflected ones", async () => {
    const app = server()
      .use(cors({ allowedHeaders: ["x-custom", "authorization"] }))
      .get("/", () => "ok")
    const res = await app.fetch(
      new Request("http://x/", {
        method: "OPTIONS",
        headers: {
          "access-control-request-method": "GET",
          "access-control-request-headers": "ignored",
        },
      }),
    )
    expect(res.headers.get("access-control-allow-headers")).toBe("x-custom, authorization")
  })

  test("allowlist echoes a listed origin (with Vary), omits an unlisted one", async () => {
    const app = server()
      .use(cors({ origin: ["https://a.com", "https://b.com"] }))
      .get("/", () => "ok")
    const allowed = await app.fetch(new Request("http://x/", origin("https://b.com")))
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://b.com")
    expect(allowed.headers.get("vary")).toContain("Origin")
    const denied = await app.fetch(new Request("http://x/", origin("https://evil.com")))
    expect(denied.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("predicate origin", async () => {
    const app = server()
      .use(cors({ origin: (o) => o.endsWith(".trusted.com") }))
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/", origin("https://api.trusted.com")))
    expect(res.headers.get("access-control-allow-origin")).toBe("https://api.trusted.com")
  })

  test("credentials echoes the origin and sets Allow-Credentials + Expose-Headers", async () => {
    const app = server()
      .use(cors({ origin: "https://app.com", credentials: true, exposedHeaders: ["x-total"] }))
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/", origin("https://app.com")))
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.com")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
    expect(res.headers.get("access-control-expose-headers")).toBe("x-total")
  })

  test("credentials + origin:* throws at construction", () => {
    expect(() => cors({ credentials: true })).toThrow(/credentials/)
    expect(() => cors({ credentials: true, origin: "*" })).toThrow(/credentials/)
  })

  test("no Origin header → no Allow-Origin for a non-* policy", async () => {
    const app = server()
      .use(cors({ origin: "https://app.com" }))
      .get("/", () => "ok")
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("CORS headers land on error responses too", async () => {
    const app = server({ logger: silentLogger })
      .use(cors())
      .get("/boom", () => {
        throw new Error("x")
      })
    const res = await app.fetch(new Request("http://x/boom", origin("https://app.com")))
    expect(res.status).toBe(500)
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
  })
})
