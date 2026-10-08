import { expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { NIFRA_BACKEND_MOUNT } from "@nifrajs/core/mount"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"

// `createWebApp` serves `api` over HTTP only at the `apiPrefix` it is given. Without one the backend
// is loader-only, and a request under `/api` reaches page routing.

const backend = server().get("/api/ping", () => ({ ok: true }))
const api = { [NIFRA_BACKEND_MOUNT]: (request: Request) => Promise.resolve(backend.fetch(request)) }
const adapter: RenderAdapter = {
  renderToStream: () => new Response("").body ?? new ReadableStream(),
  hydrationHead: () => "",
}
const manifest: Manifest = { routes: [], layouts: {}, errors: {} }

test("without apiPrefix the backend is not served over HTTP", async () => {
  const app = createWebApp({ adapter, manifest, clientEntry: "/c.js", api })
  const res = await app.fetch(new Request("http://x/api/ping"))
  expect(res.status).toBe(404)
  expect(res.headers.get("content-type")).not.toContain("application/json")
})

test("apiPrefix serves it there, and an empty one serves it nowhere", async () => {
  const mounted = createWebApp({ adapter, manifest, clientEntry: "/c.js", api, apiPrefix: "/api" })
  expect(await (await mounted.fetch(new Request("http://x/api/ping"))).json()).toEqual({ ok: true })
  const off = createWebApp({ adapter, manifest, clientEntry: "/c.js", api, apiPrefix: "" })
  expect((await off.fetch(new Request("http://x/api/ping"))).status).toBe(404)
})
