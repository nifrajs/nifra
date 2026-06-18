import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { cacheControl } from "@nifrajs/middleware"

const cc = (res: Response) => res.headers.get("cache-control")

describe("cacheControl()", () => {
  test("sets the directive on a GET 2xx that lacks one", async () => {
    const app = server()
      .use(cacheControl("public, max-age=60"))
      .get("/", () => ({ ok: true }))
    expect(cc(await app.fetch(new Request("http://x/")))).toBe("public, max-age=60")
  })

  test("does not overwrite a Cache-Control the handler already set", async () => {
    const app = server()
      .use(cacheControl("public, max-age=60"))
      .get("/", () => new Response("x", { headers: { "cache-control": "no-store" } }))
    expect(cc(await app.fetch(new Request("http://x/")))).toBe("no-store")
  })

  test("respectExisting:false overrides the handler's value", async () => {
    const app = server()
      .use(cacheControl("public, max-age=60", { respectExisting: false }))
      .get("/", () => new Response("x", { headers: { "cache-control": "no-store" } }))
    expect(cc(await app.fetch(new Request("http://x/")))).toBe("public, max-age=60")
  })

  test("skips non-GET/HEAD methods by default", async () => {
    const app = server()
      .use(cacheControl("public, max-age=60"))
      .post("/", () => ({ ok: true }))
    expect(cc(await app.fetch(new Request("http://x/", { method: "POST" })))).toBeNull()
  })

  test("skips non-2xx responses by default", async () => {
    const app = server()
      .use(cacheControl("public, max-age=60"))
      .get("/", () => new Response("nope", { status: 404 }))
    expect(cc(await app.fetch(new Request("http://x/")))).toBeNull()
  })

  test("function value: per-path directive, undefined leaves the response untouched", async () => {
    const app = server()
      .use(
        cacheControl((req) =>
          new URL(req.url).pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : undefined,
        ),
      )
      .get("/assets/app.js", () => new Response("code"))
      .get("/page", () => ({ ok: true }))
    expect(cc(await app.fetch(new Request("http://x/assets/app.js")))).toBe(
      "public, max-age=31536000, immutable",
    )
    expect(cc(await app.fetch(new Request("http://x/page")))).toBeNull()
  })

  test("honors custom methods + status predicate", async () => {
    const app = server()
      .use(cacheControl("private", { methods: ["POST"], status: (s) => s === 201 }))
      .post("/", () => new Response("made", { status: 201 }))
    expect(cc(await app.fetch(new Request("http://x/", { method: "POST" })))).toBe("private")
  })
})
