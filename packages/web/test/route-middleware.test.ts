import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverRoutes } from "../src/fs.ts"
import {
  buildManifest,
  createWebApp,
  generateClientEntry,
  generateServerManifest,
  type LoaderContext,
  notFound,
  type RenderAdapter,
  type RouteMiddleware,
  type RouteModule,
  redirect,
} from "../src/index.ts"
import { DATA_HEADER, REDIRECT_HEADER } from "../src/router.ts"

// A directory's `_layout.backend.ts` may export `middleware`. It runs before the layouts, loaders and
// action of every route in its directory and below, outermost first, and answers the request by
// returning or throwing a response. A directory needs no frontend layout to have middleware.

const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

// Emits what was rendered as JSON, so a test reads the chain and the data back.
const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(`<main>${JSON.stringify({ chain, data: props.data })}</main>`),
  hydrationHead: () => "",
}

const renderedOf = (html: string): { chain: string[]; data: unknown } => {
  const match = /<main>(.*?)<\/main>/s.exec(html)
  if (match === null) throw new Error(`no render in: ${html}`)
  return JSON.parse(match[1] as string)
}

type Module = Partial<RouteModule> & {
  readonly gate?: boolean
  readonly default?: unknown
  readonly middleware?: unknown
}
type Modules = Record<string, Module>

// A frontend file renders as its own name; a backend half carries only what the test gives it.
const appOf = (modules: Modules) => {
  const manifest = buildManifest(
    Object.keys(modules),
    (file) => () =>
      Promise.resolve(
        (file.includes(".backend.")
          ? { ...modules[file] }
          : { default: file, ...modules[file] }) as RouteModule,
      ),
  )
  return { manifest, app: createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" }) }
}

const get = (
  app: { fetch(r: Request): Response | Promise<Response> },
  path: string,
  headers: Record<string, string> = {},
) => app.fetch(new Request(`http://x${path}`, { headers }))

const post = (
  app: { fetch(r: Request): Response | Promise<Response> },
  path: string,
  headers: Record<string, string> = {},
) =>
  app.fetch(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: "a=1",
    }),
  )

const query = (ctx: LoaderContext, name: string): string | null =>
  new URL(ctx.request.url).searchParams.get(name)

/** An org area: root middleware, org middleware, a gated layout and a page, each logging its run. */
const orgApp = () => {
  const calls: string[] = []
  const seen: Record<string, Record<string, string>> = {}
  const middleware =
    (name: string): RouteMiddleware =>
    (ctx) => {
      calls.push(name)
      seen[name] = { ...ctx.params }
      const answer = query(ctx, name)
      if (answer === "redirect") return redirect("/login")
      if (answer === "throw") throw redirect("/login")
      if (answer === "forbidden") return new Response("no entry", { status: 403 })
      if (answer === "missing") notFound()
      if (answer === "fail") throw new Error(`${name} failed`)
      if (answer === "data") return { user: "ada" } as never
      ctx.set.headers["x-middleware"] = name
      ctx.set.headers[`x-${name}`] = "1"
      if (answer === "cookie") ctx.set.cookie("seen", name)
      return undefined
    }
  const { app, manifest } = appOf({
    // The root directory has middleware and no frontend layout.
    "_layout.backend.ts": { middleware: middleware("root") },
    "_404.tsx": {},
    "_error.tsx": {},
    "index.tsx": {},
    "login.tsx": {},
    "orgs/[org]/_error.tsx": {},
    "orgs/[org]/_404.tsx": {},
    "orgs/[org]/_layout.tsx": { gate: true },
    "orgs/[org]/_layout.backend.ts": {
      middleware: middleware("org"),
      loader: () => {
        calls.push("gate")
        return { layout: true }
      },
    },
    "orgs/[org]/projects/[id].tsx": {},
    "orgs/[org]/projects/[id].backend.ts": {
      loader: (ctx) => {
        calls.push("page")
        if (query(ctx, "page") === "header") ctx.set.headers["x-middleware"] = "page"
        return { id: ctx.params.id }
      },
      action: () => {
        calls.push("action")
        return { saved: true }
      },
    },
  })
  return { app, manifest, calls, seen }
}

describe("buildManifest - middleware", () => {
  const load = () => () => Promise.resolve({ default: null })

  test("records each route's middleware chain, outermost first, with the params of its prefix", () => {
    const manifest = buildManifest(
      [
        "_layout.backend.ts",
        "index.tsx",
        "orgs/[org]/_layout.backend.js",
        "orgs/[org]/projects/[id].tsx",
        "(app)/_layout.tsx",
        "(app)/_layout.backend.ts",
        "(app)/settings.tsx",
        "about.tsx",
      ],
      load,
    )
    const route = (pattern: string) => manifest.routes.find((r) => r.pattern === pattern)
    expect(route("/orgs/:org/projects/:id")).toMatchObject({
      middlewareIds: ["_middleware", "orgs/[org]/_middleware"],
      middlewareParams: [[], ["org"]],
    })
    expect(route("/settings")).toMatchObject({
      middlewareIds: ["_middleware", "(app)/_middleware"],
      middlewareParams: [[], []],
    })
    expect(route("/")?.middlewareIds).toEqual(["_middleware"])
    expect(Object.keys(manifest.middlewares ?? {}).sort()).toEqual([
      "(app)/_middleware",
      "_middleware",
      "orgs/[org]/_middleware",
    ])
    expect(manifest.middlewares?.["orgs/[org]/_middleware"]?.file).toBe(
      "orgs/[org]/_layout.backend.js",
    )
    // A middleware-only directory is not a layout: nothing renders there.
    expect(Object.keys(manifest.layouts)).toEqual(["(app)/_layout"])
    expect(manifest.layouts["(app)/_layout"]?.backend).toBe("(app)/_layout.backend.ts")
  })

  test("a route with no layout backend half above it carries none, and an app with none has no map", () => {
    const manifest = buildManifest(
      ["index.tsx", "admin/_layout.backend.ts", "admin/index.tsx"],
      load,
    )
    expect("middlewareIds" in (manifest.routes.find((r) => r.pattern === "/") ?? {})).toBe(false)
    expect(buildManifest(["index.tsx"], load).middlewares).toBeUndefined()
  })

  test("a nested _404 runs the middleware at or above its directory", () => {
    const manifest = buildManifest(
      [
        "_layout.backend.ts",
        "orgs/[org]/_layout.backend.ts",
        "orgs/[org]/_404.tsx",
        "orgs/[org]/a.tsx",
      ],
      load,
    )
    const page = manifest.notFounds?.["orgs/[org]/_404"]
    expect(page?.middlewareIds).toEqual(["_middleware", "orgs/[org]/_middleware"])
    expect(page?.scopes.map((scope) => scope.middlewareParams)).toEqual([
      [[], ["org"]],
      [[], ["org"]],
    ])
  })

  test("a retired _middleware file is refused with the migration, whatever its extension", () => {
    for (const file of ["admin/_middleware.ts", "admin/_middleware.tsx"]) {
      expect(() => buildManifest([file, "admin/index.tsx"], load)).toThrow(
        "admin/_layout.backend.ts",
      )
    }
  })

  test("two backend halves for one directory are refused", () => {
    expect(() => buildManifest(["_layout.backend.ts", "_layout.backend.js"], load)).toThrow(
      "two backend halves for one route",
    )
  })
})

describe("route middleware - requests", () => {
  test("runs outermost first, before the gate and the loader, with its directory's params", async () => {
    const { app, calls, seen } = orgApp()
    const res = await get(app, "/orgs/acme/projects/7")
    expect(res.status).toBe(200)
    expect(renderedOf(await res.text()).data).toEqual({ id: "7" })
    expect(calls).toEqual(["root", "org", "gate", "page"])
    expect(seen).toEqual({ root: {}, org: { org: "acme" } })
  })

  test("a returned or thrown redirect answers, and nothing below it runs", async () => {
    for (const how of ["redirect", "throw"]) {
      const { app, calls } = orgApp()
      const res = await get(app, `/orgs/acme/projects/7?org=${how}`)
      expect(res.status).toBe(303)
      expect(res.headers.get("location")).toBe("/login")
      expect(calls).toEqual(["root", "org"])
    }
  })

  test("a returned Response is the answer", async () => {
    const { app, calls } = orgApp()
    const res = await get(app, "/orgs/acme/projects/7?root=forbidden")
    expect(res.status).toBe(403)
    expect(await res.text()).toBe("no entry")
    expect(calls).toEqual(["root"])
  })

  test("notFound() renders the root _404, as a gate's does", async () => {
    const { app, calls } = orgApp()
    const res = await get(app, "/orgs/acme/projects/7?org=missing")
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text()).chain).toEqual(["_404.tsx"])
    expect(calls).toEqual(["root", "org"])
  })

  test("a failure renders the nearest _error at or above the middleware's directory", async () => {
    const org = orgApp()
    const orgFailure = await get(org.app, "/orgs/acme/projects/7?org=fail")
    expect(orgFailure.status).toBe(500)
    expect(renderedOf(await orgFailure.text())).toMatchObject({
      chain: ["orgs/[org]/_layout.tsx", "orgs/[org]/_error.tsx"],
      data: { message: "org failed" },
    })
    const root = orgApp()
    const rootFailure = await get(root.app, "/orgs/acme/projects/7?root=fail")
    expect(renderedOf(await rootFailure.text())).toMatchObject({
      chain: ["_error.tsx"],
      data: { message: "root failed" },
    })
  })

  test("returning data is an error, not a silent pass", async () => {
    const { app, calls } = orgApp()
    const res = await get(app, "/orgs/acme/projects/7?org=data")
    expect(res.status).toBe(500)
    expect(renderedOf(await res.text()).data).toMatchObject({
      message: expect.stringContaining(
        'the middleware in "orgs/[org]/_layout.backend.ts" returned a value',
      ),
    })
    expect(calls).toEqual(["root", "org"])
  })

  test("its headers land on the page under the layouts' and the page's", async () => {
    const { app } = orgApp()
    const own = await get(app, "/orgs/acme/projects/7")
    expect(own.headers.get("x-middleware")).toBe("org")
    expect(own.headers.get("x-root")).toBe("1")
    expect(own.headers.get("x-org")).toBe("1")
    const overridden = await get(app, "/orgs/acme/projects/7?page=header")
    expect(overridden.headers.get("x-middleware")).toBe("page")
  })

  test("a cookie it queues rides the page and makes it private", async () => {
    const { app } = orgApp()
    const res = await get(app, "/orgs/acme/projects/7?org=cookie")
    expect(res.headers.getSetCookie()).toEqual(["seen=org; Path=/; HttpOnly; Secure; SameSite=Lax"])
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })

  test("runs on a client navigation's data request, its redirect riding x-nifra-redirect", async () => {
    for (const how of ["redirect", "throw"]) {
      const { app, calls } = orgApp()
      const res = await get(app, `/orgs/acme/projects/7?org=${how}`, { [DATA_HEADER]: "1" })
      expect(res.status).toBe(204)
      expect(res.headers.get(REDIRECT_HEADER)).toBe("/login")
      expect(calls).toEqual(["root", "org"])
    }
  })

  test("runs before a form post's action, and its redirect stops the action", async () => {
    const passed = orgApp()
    expect((await post(passed.app, "/orgs/acme/projects/7")).status).toBe(200)
    expect(passed.calls).toEqual(["root", "org", "gate", "action", "page"])

    const stopped = orgApp()
    const res = await post(stopped.app, "/orgs/acme/projects/7?org=redirect", {
      [DATA_HEADER]: "1",
    })
    expect(res.status).toBe(204)
    expect(res.headers.get(REDIRECT_HEADER)).toBe("/login")
    expect(stopped.calls).toEqual(["root", "org"])
  })

  test("runs before a nested _404 answers an unmatched URL under its directory", async () => {
    const { app, calls, seen } = orgApp()
    const res = await get(app, "/orgs/acme/nowhere")
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text()).chain).toEqual([
      "orgs/[org]/_layout.tsx",
      "orgs/[org]/_404.tsx",
    ])
    expect(calls).toEqual(["root", "org", "gate"])
    expect(seen.org).toEqual({ org: "acme" })

    const guarded = orgApp()
    const redirected = await get(guarded.app, "/orgs/acme/nowhere?org=redirect")
    expect(redirected.status).toBe(303)
    expect(guarded.calls).toEqual(["root", "org"])
  })

  test("a middleware export that is not a function fails loudly", async () => {
    const { app } = appOf({
      "_error.tsx": {},
      "_layout.backend.ts": { middleware: "not a function" },
      "index.tsx": {},
    })
    const res = await get(app, "/")
    expect(res.status).toBe(500)
    expect(renderedOf(await res.text()).data).toMatchObject({
      message: '[nifra/web] "_layout.backend.ts" exports a middleware that is not a function.',
    })
  })

  test("a layout backend half without middleware is layout data only: the request runs on", async () => {
    const { app } = appOf({
      "_layout.tsx": {},
      "_layout.backend.ts": { loader: () => ({ shell: true }) },
      "index.tsx": {},
    })
    const res = await get(app, "/")
    expect(res.status).toBe(200)
  })

  test("a middleware-only directory's backend half may export only middleware", async () => {
    const { app } = appOf({
      "_error.tsx": {},
      "admin/_layout.backend.ts": { middleware: () => undefined, loader: () => ({}) },
      "admin/index.tsx": {},
    })
    const res = await get(app, "/admin")
    expect(res.status).toBe(500)
    expect(renderedOf(await res.text()).data).toMatchObject({
      message: expect.stringContaining(
        "has no _layout frontend file, so it may export only middleware",
      ),
    })
  })

  test("only a directory's _layout.backend.ts may export middleware", async () => {
    const { manifest } = appOf({
      "index.tsx": {},
      "index.backend.ts": { middleware: () => undefined },
    })
    await expect(manifest.routes[0]?.load() as Promise<unknown>).rejects.toThrow(
      "only a directory's _layout.backend.ts may export",
    )
  })
})

describe("route middleware - files", () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  test("discovery collects _layout.backend.ts; the server manifest imports it and the client never does", () => {
    const dir = mkdtempSync(join(tmpdir(), "nifra-middleware-"))
    dirs.push(dir)
    mkdirSync(join(dir, "admin"), { recursive: true })
    writeFileSync(join(dir, "index.tsx"), "export default () => null\n")
    writeFileSync(join(dir, "admin/index.tsx"), "export default () => null\n")
    writeFileSync(
      join(dir, "admin/_layout.backend.ts"),
      "export const middleware = () => undefined\n",
    )
    writeFileSync(join(dir, "admin/helper.ts"), "export const x = 1\n")

    const manifest = discoverRoutes(dir)
    expect(Object.keys(manifest.middlewares ?? {})).toEqual(["admin/_middleware"])
    expect(manifest.routes.find((r) => r.pattern === "/admin")?.middlewareIds).toEqual([
      "admin/_middleware",
    ])

    const server = generateServerManifest(manifest, {
      resolve: (file) => `./routes/${file}`,
      clientEntry: "/c.js",
    })
    expect(server).toContain('"admin/_layout.backend.ts"')
    expect(server).toContain('from "./routes/admin/_layout.backend"')
    const client = generateClientEntry(manifest, {
      clientModule: "@nifrajs/web-react/client",
      resolve: (file) => `./routes/${file}`,
    })
    expect(client).not.toContain(".backend")
  })

  test("a retired _middleware.ts on disk fails discovery instead of being ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "nifra-middleware-"))
    dirs.push(dir)
    writeFileSync(join(dir, "index.tsx"), "export default () => null\n")
    writeFileSync(join(dir, "_middleware.ts"), "export default () => undefined\n")
    expect(() => discoverRoutes(dir)).toThrow('"_middleware.ts" is retired')
  })
})
