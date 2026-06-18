import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { openapi } from "../src/index.ts"

function appWith(opts: Parameters<typeof openapi>[0]) {
  return server()
    .use(openapi(opts))
    .get("/users/:id", (c) => ({ id: c.params.id }))
}

async function text(app: { fetch(r: Request): Response | Promise<Response> }, path: string) {
  const res = await app.fetch(new Request(`http://t${path}`))
  return { res, body: await res.text() }
}

describe("openapi ui (scalar)", () => {
  test("ui: true serves a Scalar page at /reference pointing at the spec", async () => {
    const app = appWith({ ui: true, info: { title: "My API" } })
    const { res, body } = await text(app, "/reference")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(body).toContain('<script id="api-reference" data-url="/openapi.json">')
    expect(body).toContain("@scalar/api-reference")
    expect(body).toContain("<title>My API</title>")
  })

  test("the spec excludes the UI page itself", async () => {
    const app = appWith({ ui: true })
    const { body } = await text(app, "/openapi.json")
    const doc = JSON.parse(body) as { paths: Record<string, unknown> }
    expect(doc.paths["/users/{id}"]).toBeDefined()
    expect(doc.paths["/reference"]).toBeUndefined()
    expect(doc.paths["/openapi.json"]).toBeUndefined()
  })

  test("ui options: custom path, title, and CDN", async () => {
    const app = appWith({
      ui: { path: "/docs", title: "Docs", cdn: "https://cdn.example/scalar.js" },
    })
    const { res, body } = await text(app, "/docs")
    expect(res.status).toBe(200)
    expect(body).toContain("<title>Docs</title>")
    expect(body).toContain('src="https://cdn.example/scalar.js"')
    expect((await text(app, "/reference")).res.status).toBe(404) // default path not registered
  })

  test("without ui, no reference route is served", async () => {
    const app = appWith({})
    expect((await text(app, "/reference")).res.status).toBe(404)
    expect((await text(app, "/openapi.json")).res.status).toBe(200)
  })

  test("escapes interpolated config so a stray quote/angle can't break the markup", async () => {
    const app = appWith({ ui: { title: 'A"<b>', cdn: 'https://x/"onerror' } })
    const { body } = await text(app, "/reference")
    expect(body).toContain('<title>A"&lt;b></title>') // text content: only & and < are escaped
    expect(body).toContain('src="https://x/&quot;onerror"') // attribute: " is escaped
  })
})
