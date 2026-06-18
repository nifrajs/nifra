import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { timing } from "../src/index.ts"

describe("timing()", () => {
  test("emits total and custom Server-Timing metrics", async () => {
    const app = server()
      .use(timing({ precision: 0 }))
      .get("/", (c) => {
        c.timing.metric("db", 4.6, "select")
        return { ok: true }
      })

    const res = await app.fetch(new Request("http://x/"))
    const header = res.headers.get("server-timing") ?? ""
    expect(header).toMatch(/total;dur=\d+/)
    expect(header).toContain('db;dur=5;desc="select"')
  })

  test("supports marks and existing Server-Timing headers", async () => {
    const app = server()
      .use(timing({ total: false, precision: 3 }))
      .get("/", (c) => {
        c.timing.mark("start")
        c.timing.mark("end")
        c.timing.measure("handler", "start", "end")
        return new Response("ok", { headers: { "server-timing": "upstream;dur=1" } })
      })

    const res = await app.fetch(new Request("http://x/"))
    const header = res.headers.get("server-timing") ?? ""
    expect(header).toContain("upstream;dur=1")
    expect(header).toMatch(/handler;dur=\d+\.\d{3}/)
  })

  test("can be disabled", async () => {
    const app = server()
      .use(timing({ enabled: false }))
      .get("/", () => ({ ok: true }))

    expect((await app.fetch(new Request("http://x/"))).headers.get("server-timing")).toBeNull()
  })

  test("validates construction", () => {
    expect(() => timing({ total: "bad name" })).toThrow(/metric name/)
    expect(() => timing({ precision: -1 })).toThrow(/precision/)
    expect(() => timing({ precision: 7 })).toThrow(/precision/)
  })
})
