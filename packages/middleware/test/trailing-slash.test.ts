import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { appendTrailingSlash, trimTrailingSlash } from "../src/index.ts"

describe("trailing slash middleware", () => {
  test("trimTrailingSlash redirects non-root paths and preserves the query string", async () => {
    const app = server()
      .use(trimTrailingSlash())
      .get("/docs", () => "ok")

    const res = await app.fetch(new Request("http://x/docs/?a=1"))
    expect(res.status).toBe(308)
    expect(res.headers.get("location")).toBe("http://x/docs?a=1")
  })

  test("trimTrailingSlash rewrite mode routes internally", async () => {
    const app = server()
      .use(trimTrailingSlash({ mode: "rewrite" }))
      .get("/docs", () => ({ ok: true }))

    const res = await app.fetch(new Request("http://x/docs/"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("appendTrailingSlash redirects paths and skips file-looking paths by default", async () => {
    const app = server()
      .use(appendTrailingSlash())
      .get("/docs/", () => "ok")
      .get("/app.css", () => "css")

    const docs = await app.fetch(new Request("http://x/docs"))
    expect(docs.status).toBe(308)
    expect(docs.headers.get("location")).toBe("http://x/docs/")

    const css = await app.fetch(new Request("http://x/app.css"))
    expect(css.status).toBe(200)
    expect(await css.text()).toBe('"css"')
  })

  test("honors method and ignore options", async () => {
    const app = server()
      .use(appendTrailingSlash({ methods: ["POST"], ignore: (path) => path === "/skip" }))
      .get("/docs", () => "get")
      .post("/docs/", () => "post")
      .post("/skip", () => "skip")

    expect((await app.fetch(new Request("http://x/docs"))).status).toBe(200)
    expect((await app.fetch(new Request("http://x/docs", { method: "POST" }))).status).toBe(308)
    expect((await app.fetch(new Request("http://x/skip", { method: "POST" }))).status).toBe(200)
  })

  test("validates redirect status", () => {
    expect(() => trimTrailingSlash({ status: 303 as 308 })).toThrow(/status/)
    expect(() => appendTrailingSlash({ status: 200 as 308 })).toThrow(/status/)
  })
})
