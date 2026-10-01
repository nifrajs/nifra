import { describe, expect, test } from "bun:test"
import {
  buildManifest,
  createWebApp,
  type RenderAdapter,
  type RouteModule,
  redirect,
} from "../src/index.ts"
import { DATA_HEADER, REDIRECT_HEADER } from "../src/router.ts"

// fetch follows a 3xx, so a navigation's data request that is redirected would hand the client router
// another page's data under the route it asked for. Every redirect it can meet rides x-nifra-redirect
// on a 204 instead, as an action's does.

const stub: RenderAdapter = {
  renderToStream: () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("<main></main>"))
        c.close()
      },
    }),
  hydrationHead: () => "",
}

type Modules = Record<string, Partial<RouteModule> & { readonly gate?: boolean }>

const appOf = (modules: Modules) =>
  createWebApp({
    adapter: stub,
    manifest: buildManifest(
      Object.keys(modules),
      (file) => () => Promise.resolve({ default: file, ...modules[file] } as RouteModule),
    ),
    clientEntry: "/c.js",
  })

const get = (
  app: { fetch(r: Request): Response | Promise<Response> },
  path: string,
  headers: Record<string, string> = {},
) => app.fetch(new Request(`http://x${path}`, { headers }))

const redirecting = () =>
  appOf({
    "index.tsx": {},
    "login.tsx": {},
    "returned.tsx": { loader: () => redirect("/login") },
    "thrown.tsx": {
      loader: () => {
        throw redirect("/login?next=%2Fthrown")
      },
    },
    "native.tsx": { loader: () => Response.redirect("http://x/login", 307) },
    "external.tsx": { loader: () => redirect("https://id.example/auth", { external: true }) },
    "cookie.tsx": {
      loader: (ctx) => {
        ctx.set.cookie("session", "", { maxAge: 0 })
        return redirect("/login")
      },
    },
    "admin/_layout.tsx": {
      gate: true,
      loader: () => {
        throw redirect("/login")
      },
    },
    "admin/index.tsx": {},
  })

describe("a redirect answering a navigation's data request", () => {
  test("each kind becomes a 204 carrying x-nifra-redirect, never stored", async () => {
    const app = redirecting()
    const cases: Array<[string, string]> = [
      ["/returned", "/login"],
      ["/thrown", "/login?next=%2Fthrown"],
      ["/native", "http://x/login"],
      ["/external", "https://id.example/auth"],
      ["/admin", "/login"],
    ]
    for (const [path, location] of cases) {
      const res = await get(app, path, { [DATA_HEADER]: "1" })
      expect({ path, status: res.status, to: res.headers.get(REDIRECT_HEADER) }).toEqual({
        path,
        status: 204,
        to: location,
      })
      expect(res.headers.get("cache-control")).toBe("private, no-store")
      expect(res.headers.get("vary")).toBe(DATA_HEADER)
      expect(res.headers.get("location")).toBeNull()
    }
  })

  test("a document request still gets the redirect itself", async () => {
    const res = await get(redirecting(), "/returned")
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/login")
    expect(res.headers.get(REDIRECT_HEADER)).toBeNull()
  })

  test("a cookie queued before the redirect rides the 204", async () => {
    const res = await get(redirecting(), "/cookie", { [DATA_HEADER]: "1" })
    expect(res.status).toBe(204)
    expect(res.headers.get(REDIRECT_HEADER)).toBe("/login")
    expect(res.headers.getSetCookie()).toEqual([
      "session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    ])
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })

  test("a page that answers normally is untouched", async () => {
    const res = await get(redirecting(), "/", { [DATA_HEADER]: "1" })
    expect(res.status).toBe(200)
    expect(res.headers.get(REDIRECT_HEADER)).toBeNull()
  })
})
