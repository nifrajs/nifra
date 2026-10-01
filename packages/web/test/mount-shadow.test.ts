import { describe, expect, test } from "bun:test"
import { NIFRA_BACKEND_MOUNT } from "@nifrajs/core/mount"
import { server } from "@nifrajs/core/server"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import { formatShadowedPages, normalizeMountPath, shadowedPages } from "../src/route-manifest.ts"

// A pre-route mount answers every request under its path and its 404 is final, so a page file there
// never renders. These pin which pages count, and that every surface refuses them.

const stub: RenderAdapter = {
  renderToStream: () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("<p>page</p>"))
        c.close()
      },
    }),
  hydrationHead: () => "",
}

const route = (pattern: string, file: string) => ({
  id: file.replace(/\.tsx$/, ""),
  pattern,
  layoutIds: [],
  file,
  load: async () => ({ default: file }),
})

const manifestOf = (
  routes: ReadonlyArray<readonly [string, string]>,
  notFounds: Manifest["notFounds"] = {},
): Manifest => ({
  routes: routes.map(([pattern, file]) => route(pattern, file)),
  layouts: {},
  notFounds,
})

const backend = () => ({
  [NIFRA_BACKEND_MOUNT]: (request: Request) =>
    Promise.resolve(Response.json({ saw: new URL(request.url).pathname })),
})

describe("normalizeMountPath", () => {
  test("reads a path the way the server's mount table does", () => {
    expect(normalizeMountPath("/api")).toBe("/api")
    expect(normalizeMountPath("/api/")).toBe("/api")
    expect(normalizeMountPath("/api/*")).toBe("/api")
    expect(normalizeMountPath("/")).toBe("/")
    expect(normalizeMountPath("/*")).toBe("/")
  })

  test("refuses what the server refuses", () => {
    for (const path of ["api", "/api?x", "/api#x", "/:id", "/a/*/b", ""]) {
      expect(normalizeMountPath(path)).toBeUndefined()
    }
  })
})

describe("shadowedPages", () => {
  const manifest = manifestOf([
    ["/", "index.tsx"],
    ["/api", "api/index.tsx"],
    ["/api/report", "api/report.tsx"],
    ["/api/iap/:id", "api/iap/[id].tsx"],
    ["/api/*", "api/[...rest].tsx"],
    ["/apiary", "apiary.tsx"],
    ["/api-docs", "api-docs.tsx"],
    ["/:lang/api", "[lang]/api.tsx"],
    ["/API/x", "API/x.tsx"],
  ])

  test("reports every page at or below the mount path, on a segment boundary", () => {
    expect(shadowedPages(manifest, ["/api"]).map((page) => page.file)).toEqual([
      "api/index.tsx",
      "api/report.tsx",
      "api/iap/[id].tsx",
      "api/[...rest].tsx",
    ])
  })

  test("a param or a different case is reachable for other values and is not reported", () => {
    const files = shadowedPages(manifest, ["/api"]).map((page) => page.file)
    expect(files).not.toContain("[lang]/api.tsx")
    expect(files).not.toContain("API/x.tsx")
    expect(files).not.toContain("apiary.tsx")
  })

  test("reads the mount path normalized, and reports the normalized form", () => {
    const pages = shadowedPages(manifest, ["/api/*", "/api/"])
    expect(pages).toHaveLength(4)
    expect(new Set(pages.map((page) => page.mount))).toEqual(new Set(["/api"]))
  })

  test("a root mount shadows every page", () => {
    expect(shadowedPages(manifest, ["/"])).toHaveLength(manifest.routes.length)
  })

  test("a path the server would refuse, or no mount at all, reports nothing", () => {
    expect(shadowedPages(manifest, [])).toEqual([])
    expect(shadowedPages(manifest, ["api", "/:x"])).toEqual([])
  })

  test("a nested _404 whose scope sits under the mount is reported too", () => {
    const withNotFound = manifestOf([["/", "index.tsx"]], {
      "api/_404": {
        file: "api/_404.tsx",
        load: async () => ({ default: "nf" }),
        layoutIds: [],
        errorIds: [],
        scopes: [
          { pattern: "/api", layoutParams: [] },
          { pattern: "/api/*", layoutParams: [] },
        ],
      },
    })
    expect(shadowedPages(withNotFound, ["/api"])).toEqual([
      { file: "api/_404.tsx", pattern: "/api", mount: "/api" },
      { file: "api/_404.tsx", pattern: "/api/*", mount: "/api" },
    ])
  })

  test("the message names each file, its URL and the mount", () => {
    const text = formatShadowedPages(shadowedPages(manifest, ["/api"]).slice(0, 1))
    expect(text).toContain("1 page route can never render")
    expect(text).toContain("api/index.tsx serves /api, under the mount at /api")
    expect(text).toContain("apiPrefix")
  })
})

describe("createWebApp refuses a page under a mount", () => {
  test("the auto-mounted backend at the default prefix", () => {
    expect(() =>
      createWebApp({
        adapter: stub,
        manifest: manifestOf([
          ["/", "index.tsx"],
          ["/api/report", "api/report.tsx"],
        ]),
        clientEntry: "/c.js",
        api: backend(),
      }),
    ).toThrow("api/report.tsx serves /api/report, under the mount at /api")
  })

  test("a custom apiPrefix moves the check with it", () => {
    const manifest = manifestOf([["/api/report", "api/report.tsx"]])
    expect(() =>
      createWebApp({
        adapter: stub,
        manifest,
        clientEntry: "/c.js",
        api: backend(),
        apiPrefix: "/rpc",
      }),
    ).not.toThrow()
    expect(() =>
      createWebApp({
        adapter: stub,
        manifest: manifestOf([["/rpc/x", "rpc/x.tsx"]]),
        clientEntry: "/c.js",
        api: backend(),
        apiPrefix: "/rpc/",
      }),
    ).toThrow("under the mount at /rpc")
  })

  test('apiPrefix "" and a backend that cannot be mounted mount nothing, so nothing is shadowed', () => {
    const manifest = manifestOf([["/api/report", "api/report.tsx"]])
    expect(() =>
      createWebApp({
        adapter: stub,
        manifest,
        clientEntry: "/c.js",
        api: backend(),
        apiPrefix: "",
      }),
    ).not.toThrow()
    expect(() =>
      createWebApp({ adapter: stub, manifest, clientEntry: "/c.js", api: { fetch: () => 1 } }),
    ).not.toThrow()
  })

  test("a configured mount, with or without fallbackOn, shadows its pages", () => {
    const manifest = manifestOf([["/auth/login", "auth/login.tsx"]])
    for (const fallbackOn of [undefined, 404 as const]) {
      expect(() =>
        createWebApp({
          adapter: stub,
          manifest,
          clientEntry: "/c.js",
          mounts: [
            {
              path: "/auth",
              app: server(),
              ...(fallbackOn === undefined ? {} : { fallbackOn }),
            },
          ],
        }),
      ).toThrow("auth/login.tsx serves /auth/login, under the mount at /auth")
    }
  })

  test("a mount added inside use is read back from the server's own table", () => {
    expect(() =>
      createWebApp({
        adapter: stub,
        manifest: manifestOf([["/hooks/github", "hooks/github.tsx"]]),
        clientEntry: "/c.js",
        use: (app) => {
          app.mount({ path: "/hooks", app: server() })
        },
      }),
    ).toThrow("hooks/github.tsx serves /hooks/github, under the mount at /hooks")
  })

  test("pages outside every mount still serve, and the backend still answers its path", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest: manifestOf([
        ["/", "index.tsx"],
        ["/apiary", "apiary.tsx"],
      ]),
      clientEntry: "/c.js",
      api: backend(),
    })
    expect((await app.fetch(new Request("http://x/apiary"))).status).toBe(200)
    expect(await (await app.fetch(new Request("http://x/api/v1"))).json()).toEqual({
      saw: "/api/v1",
    })
  })
})
