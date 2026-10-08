import { afterEach, expect, spyOn, test } from "bun:test"
import { server } from "@nifrajs/core"
import { NIFRA_BACKEND_MOUNT } from "@nifrajs/core/mount"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"

// `createWebApp` mounts `api` over HTTP at `/api` when no `apiPrefix` is given. In development it says
// so once, since an app that already serves its backend elsewhere gets a second path to it.

const backend = server().get("/api/ping", () => ({ ok: true }))
const api = { [NIFRA_BACKEND_MOUNT]: (request: Request) => Promise.resolve(backend.fetch(request)) }
const adapter: RenderAdapter = {
  renderToStream: () => new Response("").body ?? new ReadableStream(),
  hydrationHead: () => "",
}
const manifest: Manifest = { routes: [], layouts: {}, errors: {} }
const previous = process.env.NODE_ENV
afterEach(() => {
  if (previous === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previous
})

test("an implicit apiPrefix warns once in development, naming the mount and both settings", async () => {
  process.env.NODE_ENV = "development"
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const app = createWebApp({ adapter, manifest, clientEntry: "/c.js", api })
    createWebApp({ adapter, manifest, clientEntry: "/c.js", api })
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain("/api")
    expect(message).toContain('apiPrefix: "/api"')
    expect(message).toContain('apiPrefix: ""')
    // The mount itself is unchanged in 4.x.
    expect(await (await app.fetch(new Request("http://x/api/ping"))).json()).toEqual({ ok: true })
  } finally {
    warn.mockRestore()
  }
})

test("an explicit apiPrefix, production, or no api says nothing", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    process.env.NODE_ENV = "development"
    createWebApp({ adapter, manifest, clientEntry: "/c.js", api, apiPrefix: "/api" })
    createWebApp({ adapter, manifest, clientEntry: "/c.js", api, apiPrefix: "" })
    createWebApp({ adapter, manifest, clientEntry: "/c.js" })
    process.env.NODE_ENV = "production"
    createWebApp({ adapter, manifest, clientEntry: "/c.js", api })
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})
