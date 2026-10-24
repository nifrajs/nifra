import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { logger, type RequestLogFields } from "@nifrajs/middleware"

describe("logger", () => {
  test("logs one structured line per request (method/path/status/ms)", async () => {
    const lines: RequestLogFields[] = []
    const app = server()
      .use(logger({ log: (f) => lines.push(f) }))
      .get("/hello", () => ({ ok: true }))

    await app.fetch(new Request("http://x/hello"))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ method: "GET", path: "/hello", status: 200 })
    expect(lines[0]?.ms).toBeGreaterThanOrEqual(0)
  })

  test("covers 404s (onResponse fires for unmatched routes)", async () => {
    const lines: RequestLogFields[] = []
    const app = server()
      .use(logger({ log: (f) => lines.push(f) }))
      .get("/", () => ({ ok: true }))

    await app.fetch(new Request("http://x/missing"))
    expect(lines[0]).toMatchObject({ path: "/missing", status: 404 })
  })

  test("logs the matched route template, never the ids or tokens in the path", async () => {
    const lines: RequestLogFields[] = []
    const app = server()
      .use(logger({ log: (f) => lines.push(f) }))
      .get("/share/:token", (c) => ({ token: c.params.token }))
      .get("/files/*", () => ({ ok: true }))

    await app.fetch(new Request("http://x/share/k7qx9?sig=abc"))
    await app.fetch(new Request("http://x/files/a/b.txt"))
    await app.fetch(new Request("http://x/share/k7qx9", { method: "HEAD" }))
    expect(lines.map((line) => line.path)).toEqual(["/share/:token", "/files/*", "/share/:token"])
  })

  test("routes registered after the logger are matched too", async () => {
    const lines: RequestLogFields[] = []
    const app = server().use(logger({ log: (f) => lines.push(f) }))
    app.get("/orders/:id", (c) => ({ id: c.params.id }))

    await app.fetch(new Request("http://x/orders/42"))
    expect(lines[0]).toMatchObject({ path: "/orders/:id", status: 200 })
  })

  test("rawPath logs the request's pathname, still without its query", async () => {
    const lines: RequestLogFields[] = []
    const app = server()
      .use(logger({ log: (f) => lines.push(f), rawPath: true }))
      .get("/share/:token", (c) => ({ token: c.params.token }))

    await app.fetch(new Request("http://x/share/k7qx9?sig=abc"))
    expect(lines[0]).toMatchObject({ path: "/share/k7qx9" })
  })

  test("default sink writes a JSON line to console", async () => {
    const original = console.log
    const captured: string[] = []
    console.log = (line: string) => captured.push(line)
    try {
      const app = server()
        .use(logger())
        .get("/", () => ({ ok: true }))
      await app.fetch(new Request("http://x/"))
    } finally {
      console.log = original
    }
    expect(captured).toHaveLength(1)
    expect(JSON.parse(captured[0] ?? "{}")).toMatchObject({ method: "GET", path: "/", status: 200 })
  })
})
