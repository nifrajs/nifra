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
