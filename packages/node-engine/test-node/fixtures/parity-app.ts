import { server, status } from "@nifrajs/core"

export function makeApp() {
  return server()
    .use({
      name: "headers",
      beforeHandle: (c) => {
        c.set.headers["x-content-type-options"] = "nosniff"
        c.set.headers.vary = "Origin"
      },
    })
    .derive((c) => {
      const auth = c.header("authorization")
      if (auth === null || !auth.startsWith("Bearer ")) {
        return status(401, { ok: false, error: "unauthorized" })
      }
      return { userId: auth.slice(7, 19), theme: c.cookies.theme ?? "light" }
    })
    .get("/orders", (c) => ({ user: c.userId, theme: c.theme, q: c.query }))
    .get("/echo-url", (c) => ({ url: c.req.url, ip: typeof c.clientIp }))
    .get("/cookies", (c) => {
      c.set.cookie("a", "1", { path: "/" })
      c.set.cookie("b", "2", { path: "/" })
      return { ok: true }
    })
    .get("/text", () => new Response("plain text", { headers: { "content-type": "text/plain" } }))
    .get("/bytes", () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 201 }))
    .get("/empty", () => new Response(null, { status: 204 }))
    .get("/redirect", () => new Response(null, { status: 302, headers: { location: "/orders" } }))
    .get("/slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { slow: true }
    })
    .get("/async-header", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { header: c.header("x-late") }
    })
    .post("/json", async (c) => {
      const body: { n: number } = await c.req.json()
      return { doubled: body.n * 2 }
    })
    .post("/raw", async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      return { length: bytes.byteLength, sum: bytes.reduce((a, b) => a + b, 0) }
    })
    .get("/throws", () => {
      throw new Error("boom")
    })
}
