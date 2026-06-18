import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GetStaticPaths, RouteEntry } from "../src/manifest.ts"
import {
  cloudflarePagesRoutes,
  htmlFileFor,
  type PrerenderApp,
  prerenderRoutes,
} from "../src/prerender.ts"

// A fake route manifest entry — the driver only reads `.pattern` and `.load()` (for `.prerender`).
function route(pattern: string, prerender?: boolean): RouteEntry {
  return {
    id: pattern,
    pattern,
    layoutIds: [],
    file: `${pattern}.tsx`,
    load: async () => ({ default: () => null, ...(prerender === undefined ? {} : { prerender }) }),
  }
}

// A fake dynamic route whose module exports `getStaticPaths`.
function dynamicRoute(pattern: string, getStaticPaths: GetStaticPaths): RouteEntry {
  return {
    id: pattern,
    pattern,
    layoutIds: [],
    file: `${pattern}.tsx`,
    load: async () => ({ default: () => null, getStaticPaths }),
  }
}

// A fake app: the document GET returns HTML; the data-mode GET (x-nifra-data header) returns the
// loader data with a content-type (JSON by default; pass NDJSON to exercise the deferred skip).
function fakeApp(
  status = 200,
  body = "<!doctype html><html><body>hi</body></html>",
  dataBody = '{"ok":true}',
  dataContentType = "application/json",
) {
  const urls: string[] = []
  const dataUrls: string[] = []
  const app: PrerenderApp = {
    fetch: async (req) => {
      if (req.headers.get("x-nifra-data") !== null) {
        dataUrls.push(req.url)
        return new Response(dataBody, { status, headers: { "content-type": dataContentType } })
      }
      urls.push(req.url)
      return new Response(body, { status })
    },
  }
  return { app, urls, dataUrls }
}

describe("htmlFileFor", () => {
  test("maps a static pattern to its output file", () => {
    expect(htmlFileFor("/")).toBe("index.html")
    expect(htmlFileFor("/about")).toBe("about/index.html")
    expect(htmlFileFor("/a/b/c")).toBe("a/b/c/index.html")
    expect(htmlFileFor("/about/")).toBe("about/index.html") // trailing slash trimmed
  })
})

describe("prerenderRoutes", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nifra-prerender-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("writes index.html for an opted-in static route + reports it", async () => {
    const { app, urls } = fakeApp(200, "<!doctype html><html><body>HOME</body></html>")
    const result = await prerenderRoutes({ app, routes: [route("/", true)], outDir: dir })

    expect(urls).toEqual(["http://localhost/"]) // synthetic GET at the default origin
    const written = readFileSync(join(dir, "index.html"), "utf8")
    expect(written).toContain("HOME")
    expect(result.prerendered).toEqual([
      { path: "/", file: "index.html", bytes: written.length, dataFile: "_data.json" },
    ])
    expect(result.skipped).toEqual([])
  })

  test("emits a static _data.json next to index.html (JSON data-mode) for soft-nav [Phase 2.3]", async () => {
    const { app, dataUrls } = fakeApp(200, "<html>x</html>", '{"user":{"id":"7"}}')
    const result = await prerenderRoutes({
      app,
      routes: [route("/users-static", true)],
      outDir: dir,
    })
    expect(dataUrls).toEqual(["http://localhost/users-static"]) // a data-mode GET was issued
    expect(readFileSync(join(dir, "users-static/_data.json"), "utf8")).toBe('{"user":{"id":"7"}}')
    expect(result.prerendered[0]?.dataFile).toBe("users-static/_data.json")
  })

  test("skips _data.json when the data-mode response is NDJSON (deferred loader)", async () => {
    const { app } = fakeApp(200, "<html>x</html>", '{"feed":0}\n', "application/x-ndjson")
    const result = await prerenderRoutes({ app, routes: [route("/feed", true)], outDir: dir })
    expect(existsSync(join(dir, "feed/index.html"))).toBe(true) // HTML still written
    expect(existsSync(join(dir, "feed/_data.json"))).toBe(false) // but no static data
    expect(result.prerendered[0]?.dataFile).toBeUndefined()
  })

  test("writes nested <path>/index.html for a nested static route", async () => {
    const { app } = fakeApp()
    const result = await prerenderRoutes({ app, routes: [route("/docs/intro", true)], outDir: dir })
    expect(existsSync(join(dir, "docs/intro/index.html"))).toBe(true)
    expect(result.prerendered[0]?.file).toBe("docs/intro/index.html")
  })

  test("skips a dynamic (param) route — deferred to getStaticPaths", async () => {
    const { app, urls } = fakeApp()
    const result = await prerenderRoutes({ app, routes: [route("/users/:id", true)], outDir: dir })
    expect(urls).toEqual([]) // never fetched
    expect(result.prerendered).toEqual([])
    expect(result.skipped[0]).toMatchObject({
      path: "/users/:id",
      reason: expect.stringContaining("getStaticPaths"),
    })
  })

  test("skips a wildcard route", async () => {
    const { app } = fakeApp()
    const result = await prerenderRoutes({
      app,
      routes: [route("/files/*path", true)],
      outDir: dir,
    })
    expect(result.prerendered).toEqual([])
    expect(result.skipped).toHaveLength(1)
  })

  test("skips a static route that didn't opt in", async () => {
    const { app, urls } = fakeApp()
    const result = await prerenderRoutes({ app, routes: [route("/about")], outDir: dir }) // no prerender flag
    expect(urls).toEqual([])
    expect(result.skipped[0]).toMatchObject({
      path: "/about",
      reason: expect.stringContaining("opted in"),
    })
  })

  test("skips (not throws) when the app renders a non-OK response", async () => {
    const { app } = fakeApp(500)
    const result = await prerenderRoutes({ app, routes: [route("/boom", true)], outDir: dir })
    expect(existsSync(join(dir, "boom/index.html"))).toBe(false)
    expect(result.prerendered).toEqual([])
    expect(result.skipped[0]).toMatchObject({
      path: "/boom",
      reason: expect.stringContaining("500"),
    })
  })

  test("honors a custom origin in the synthetic request", async () => {
    const { app, urls } = fakeApp()
    await prerenderRoutes({
      app,
      routes: [route("/", true)],
      outDir: dir,
      origin: "https://example.com",
    })
    expect(urls).toEqual(["https://example.com/"])
  })

  test("prerenders the opted-in subset and reports the rest, in one pass", async () => {
    const { app } = fakeApp()
    const result = await prerenderRoutes({
      app,
      routes: [
        route("/", true),
        route("/about", true),
        route("/users/:id", true),
        route("/private"),
      ],
      outDir: dir,
    })
    expect(result.prerendered.map((p) => p.path).sort()).toEqual(["/", "/about"])
    expect(result.skipped.map((s) => s.path).sort()).toEqual(["/private", "/users/:id"])
    expect(existsSync(join(dir, "index.html"))).toBe(true)
    expect(existsSync(join(dir, "about/index.html"))).toBe(true)
  })

  test("dynamic route: getStaticPaths enumerates concrete paths → one index.html each", async () => {
    const { app, urls } = fakeApp()
    const result = await prerenderRoutes({
      app,
      routes: [
        dynamicRoute("/users/:id", async () => ({
          paths: [{ params: { id: "1" } }, { params: { id: "2" } }],
        })),
      ],
      outDir: dir,
    })
    expect(urls.sort()).toEqual(["http://localhost/users/1", "http://localhost/users/2"])
    expect(existsSync(join(dir, "users/1/index.html"))).toBe(true)
    expect(existsSync(join(dir, "users/2/index.html"))).toBe(true)
    expect(result.prerendered.map((p) => p.path).sort()).toEqual(["/users/1", "/users/2"])
    expect(result.fallbacks).toEqual({ "/users/:id": "ssr" }) // default fallback
  })

  test("dynamic route: a multi-param pattern fills every segment", async () => {
    const { app } = fakeApp()
    const result = await prerenderRoutes({
      app,
      routes: [
        dynamicRoute("/blog/:year/:slug", async () => ({
          paths: [{ params: { year: "2026", slug: "hello" } }],
        })),
      ],
      outDir: dir,
    })
    expect(existsSync(join(dir, "blog/2026/hello/index.html"))).toBe(true)
    expect(result.prerendered[0]?.path).toBe("/blog/2026/hello")
  })

  test("dynamic route params are encoded before mapping to output files", async () => {
    const { app } = fakeApp()
    const outDir = join(dir, "out")
    const result = await prerenderRoutes({
      app,
      routes: [
        dynamicRoute("/blog/:slug", async () => ({
          paths: [{ params: { slug: "../../escape hatch" } }],
        })),
      ],
      outDir,
    })
    expect(result.skipped).toEqual([])
    expect(result.prerendered[0]).toMatchObject({
      path: "/blog/..%2F..%2Fescape%20hatch",
      file: "blog/..%2F..%2Fescape%20hatch/index.html",
      dataFile: "blog/..%2F..%2Fescape%20hatch/_data.json",
    })
    expect(existsSync(join(outDir, "blog/..%2F..%2Fescape%20hatch/index.html"))).toBe(true)
    expect(existsSync(join(dir, "escape hatch/index.html"))).toBe(false)
  })

  test("unsafe output paths are skipped even if a hand-built manifest supplies one", async () => {
    const { app } = fakeApp()
    const outDir = join(dir, "out")
    const result = await prerenderRoutes({
      app,
      routes: [route("/../escape", true)],
      outDir,
    })
    expect(result.prerendered).toEqual([])
    expect(result.skipped[0]).toEqual({ path: "/../escape", reason: "unsafe output path" })
    expect(existsSync(join(dir, "escape/index.html"))).toBe(false)
  })

  test("dynamic route: a path missing a param is skipped, not written with a literal :name", async () => {
    const { app } = fakeApp()
    const result = await prerenderRoutes({
      app,
      routes: [dynamicRoute("/users/:id", async () => ({ paths: [{ params: {} }] }))], // no `id`
      outDir: dir,
    })
    expect(result.prerendered).toEqual([])
    expect(result.skipped[0]).toMatchObject({
      path: "/users/:id",
      reason: expect.stringContaining("missing param"),
    })
  })

  test("dynamic route: fallback '404' is recorded for the deploy layer", async () => {
    const { app } = fakeApp()
    const result = await prerenderRoutes({
      app,
      routes: [
        dynamicRoute("/p/:id", async () => ({ paths: [{ params: { id: "x" } }], fallback: "404" })),
      ],
      outDir: dir,
    })
    expect(result.fallbacks).toEqual({ "/p/:id": "404" })
    expect(result.prerendered[0]?.file).toBe("p/x/index.html")
  })
})

describe("cloudflarePagesRoutes", () => {
  test("excludes assets + each prerendered doc and its _data.json from the worker", () => {
    const routes = cloudflarePagesRoutes({ prerendered: ["/", "/users/7"] })
    expect(routes).toEqual({
      version: 1,
      include: ["/*"],
      exclude: ["/assets/*", "/", "/_data.json", "/users/7", "/users/7/_data.json"],
    })
  })

  test("honors custom staticGlobs", () => {
    const routes = cloudflarePagesRoutes({ prerendered: ["/about"], staticGlobs: ["/static/*"] })
    expect(routes.exclude).toEqual(["/static/*", "/about", "/about/_data.json"])
  })
})
