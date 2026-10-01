import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClient } from "../src/build.ts"
import {
  buildManifest,
  type ClientRouter,
  createClientRouter,
  generateClientEntry,
  generateServerManifest,
  type RouteModule,
  type RouterState,
} from "../src/index.ts"
import { type LoadingRoute, withLoading } from "../src/internal/loading-runtime.ts"

// A `_loading` page is what the page slot shows while a client navigation loads: the target route's
// nearest one, inside the layouts the two pages share, once the navigation has run past a short delay.

const importer = (_file: string) => async (): Promise<RouteModule> => ({ default: () => null })
const manifestOf = (files: readonly string[]) => buildManifest(files, importer)

describe("buildManifest", () => {
  test("lists each _loading with the layouts at or above it", () => {
    const manifest = manifestOf([
      "_layout.tsx",
      "_loading.tsx",
      "index.tsx",
      "admin/_layout.tsx",
      "admin/_loading.tsx",
      "admin/users.tsx",
      "docs/_loading.tsx",
      "docs/intro.tsx",
    ])
    expect(Object.keys(manifest.loadings ?? {}).sort()).toEqual([
      "_loading",
      "admin/_loading",
      "docs/_loading",
    ])
    expect(manifest.loadings?._loading?.layoutIds).toEqual(["_layout"])
    expect(manifest.loadings?.["admin/_loading"]?.layoutIds).toEqual(["_layout", "admin/_layout"])
    // No layout in `docs/`: the page sits under the root layout alone.
    expect(manifest.loadings?.["docs/_loading"]?.layoutIds).toEqual(["_layout"])
    expect(manifest.loadings?.["admin/_loading"]?.file).toBe("admin/_loading.tsx")
  })

  test("a route lists the _loading pages above it, outermost first", () => {
    const manifest = manifestOf([
      "_loading.tsx",
      "index.tsx",
      "admin/_loading.tsx",
      "admin/users.tsx",
      "about.tsx",
    ])
    const byId = Object.fromEntries(manifest.routes.map((route) => [route.id, route.loadingIds]))
    expect(byId["admin/users"]).toEqual(["_loading", "admin/_loading"])
    expect(byId.index).toEqual(["_loading"])
    expect(byId.about).toEqual(["_loading"])
  })

  test("a _loading file is never a route, and an app without one carries no table", () => {
    const withOne = manifestOf(["index.tsx", "_loading.tsx"])
    expect(withOne.routes.map((route) => route.id)).toEqual(["index"])
    const without = manifestOf(["index.tsx", "admin/users.tsx"])
    expect(without.loadings).toBeUndefined()
    expect(without.routes.every((route) => route.loadingIds === undefined)).toBe(true)
  })
})

describe("generateClientEntry", () => {
  const options = { clientModule: "./client", resolve: (file: string) => `./routes/${file}` }

  test("wraps the router only when the app has a _loading page", () => {
    const plain = generateClientEntry(manifestOf(["_layout.tsx", "index.tsx"]), options)
    expect(plain).not.toContain("loading-runtime")
    expect(plain).not.toContain("withLoading")

    const source = generateClientEntry(
      manifestOf([
        "_layout.tsx",
        "_loading.tsx",
        "index.tsx",
        "admin/_layout.tsx",
        "admin/_loading.tsx",
        "admin/users.tsx",
      ]),
      options,
    )
    expect(source).toContain('import { withLoading } from "@nifrajs/web/internal/loading-runtime"')
    expect(source).toContain("const router = withLoading(createClientRouter(")
    // Each loading page is its own lazy import, never part of a route's chain.
    expect(source).toContain('"_loading": () => import("./routes/_loading.tsx"),')
    expect(source).toContain('"admin/_loading": () => import("./routes/admin/_loading.tsx"),')
    // A route row: its layout ids, then the loading pages above it with the layouts each sits under.
    expect(source).toContain('"index": [["_layout"],[["_loading",1]]],')
    expect(source).toContain(
      '"admin/users": [["_layout","admin/_layout"],[["_loading",1],["admin/_loading",2]]],',
    )
  })
})

describe("generateServerManifest", () => {
  test("leaves _loading files out: the server never renders one", () => {
    const source = generateServerManifest(manifestOf(["index.tsx", "_loading.tsx"]), {
      clientEntry: "/c.js",
      resolve: (file) => `./routes/${file}`,
    })
    expect(source).not.toContain("_loading")
  })
})

// ── the runtime ───────────────────────────────────────────────────────────────────────────────────

const patterns = [
  { routeId: "index", pattern: "/" },
  { routeId: "about", pattern: "/about" },
  { routeId: "admin/index", pattern: "/admin" },
  { routeId: "admin/users", pattern: "/admin/users" },
  { routeId: "admin/reports", pattern: "/admin/reports" },
]

const Root = "Root"
const Admin = "Admin"
const RootLoading = "RootLoading"
const AdminLoading = "AdminLoading"

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Harness {
  readonly router: ClientRouter
  readonly chains: Record<string, readonly unknown[]>
  readonly searchSchemas: Record<string, readonly unknown[]>
  /** Settle the in-flight data request for `path`. */
  readonly settle: (path: string, data?: unknown) => void
  readonly fail: (path: string, error?: Error) => void
  readonly fellBack: string[]
  readonly imported: string[]
}

function harness(
  over: {
    readonly initial?: Partial<RouterState>
    readonly routes?: Readonly<Record<string, LoadingRoute>>
    readonly delayMs?: number
    readonly failModule?: string
  } = {},
): Harness {
  // A request and its answer may arrive in either order: the router loads the route's chunk before it
  // fetches, so a test that settles right after `navigate` answers a request not yet made.
  const waiting = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()
  const answers = new Map<string, { readonly data: unknown } | { readonly error: Error }>()
  const chains: Record<string, readonly unknown[]> = {
    index: [Root, "IndexPage"],
    about: [Root, "AboutPage"],
    "admin/index": [Root, Admin, "AdminPage"],
    "admin/users": [Root, Admin, "UsersPage"],
    "admin/reports": [Root, Admin, "ReportsPage"],
  }
  const searchSchemas: Record<string, readonly unknown[]> = {
    index: ["root-schema", "index-schema"],
    "admin/index": ["root-schema", "admin-schema", "admin-index-schema"],
  }
  const fellBack: string[] = []
  const imported: string[] = []
  const inner = createClientRouter({
    patterns,
    initial: {
      routeId: "index",
      params: {},
      path: "/",
      data: { page: "index" },
      layoutData: [{ from: "root" }],
      pending: false,
      ...over.initial,
    },
    fetchData: (path) =>
      new Promise((resolve, reject) => {
        const answer = answers.get(path)
        if (answer === undefined) waiting.set(path, { resolve, reject })
        else if ("error" in answer) reject(answer.error)
        else resolve(answer.data)
      }),
  })
  const routes: Readonly<Record<string, LoadingRoute>> = over.routes ?? {
    index: [["_layout"], [["_loading", 1]]],
    about: [["_layout"], [["_loading", 1]]],
    "admin/index": [
      ["_layout", "admin/_layout"],
      [
        ["_loading", 1],
        ["admin/_loading", 2],
      ],
    ],
    "admin/users": [
      ["_layout", "admin/_layout"],
      [
        ["_loading", 1],
        ["admin/_loading", 2],
      ],
    ],
    "admin/reports": [
      ["_layout", "admin/_layout"],
      [
        ["_loading", 1],
        ["admin/_loading", 2],
      ],
    ],
  }
  const moduleOf = (id: string, component: string) => async () => {
    imported.push(id)
    if (over.failModule === id) throw new Error("chunk failed")
    return { default: component }
  }
  const router = withLoading(inner, {
    routes,
    modules: {
      _loading: moduleOf("_loading", RootLoading),
      "admin/_loading": moduleOf("admin/_loading", AdminLoading),
    },
    chains,
    searchSchemas,
    delayMs: over.delayMs ?? 5,
    fallback: (path) => fellBack.push(path),
  })
  return {
    router,
    chains,
    searchSchemas,
    settle: (path, data = { page: path }) => {
      answers.set(path, { data })
      waiting.get(path)?.resolve(data)
    },
    fail: (path, error = new Error("fetch failed")) => {
      answers.set(path, { error })
      waiting.get(path)?.reject(error)
    },
    fellBack,
    imported,
  }
}

const chainOf = (h: Harness): readonly unknown[] => h.chains[h.router.snapshot().routeId] ?? []

describe("withLoading", () => {
  test("a navigation still loading after the delay shows the loading page inside the shared layouts", async () => {
    const h = harness()
    const done = h.router.navigate("/about")
    // Before the delay: the current page, pending.
    expect(h.router.snapshot().routeId).toBe("index")
    expect(h.router.snapshot().pending).toBe(true)
    await done // settles once the loading page is on screen, not when the data arrives
    const state = h.router.snapshot()
    expect(chainOf(h)).toEqual([Root, RootLoading])
    expect(state.pending).toBe(true)
    expect(state.pendingPath).toBe("/about")
    // The layouts keep their data, the URL-derived fields stay the current page's, the leaf has none.
    expect(state.layoutData).toEqual([{ from: "root" }])
    expect(state.path).toBe("/")
    expect(state.data).toBeNull()
    // The layouts read the same search as before: the current route's schema chain.
    expect(h.searchSchemas[state.routeId]).toEqual(["root-schema", "index-schema"])

    h.settle("/about")
    await tick(5)
    expect(h.router.snapshot().routeId).toBe("about")
    expect(h.router.snapshot().pending).toBe(false)
    expect(h.router.snapshot().data).toEqual({ page: "/about" })
  })

  test("a navigation that settles before the delay never shows it", async () => {
    const h = harness({ delayMs: 40 })
    const seen: string[] = []
    h.router.subscribe(() => seen.push(h.router.snapshot().routeId))
    const done = h.router.navigate("/about")
    h.settle("/about")
    await done
    await tick(60)
    expect(seen).toEqual(["index", "about"])
    expect(h.router.snapshot().routeId).toBe("about")
  })

  test("the snapshot is referentially stable while the loading page is up", async () => {
    const h = harness()
    await h.router.navigate("/about")
    const first = h.router.snapshot()
    expect(h.router.snapshot()).toBe(first)
    h.settle("/about")
    await tick(5)
  })

  test("the innermost loading page wins when its layouts are on screen", async () => {
    const h = harness({
      initial: {
        routeId: "admin/index",
        path: "/admin",
        layoutData: [{ from: "root" }, { from: "admin" }],
      },
    })
    await h.router.navigate("/admin/users")
    // Both layouts are shared, so the admin page shows, inside both.
    expect(chainOf(h)).toEqual([Root, Admin, AdminLoading])
    expect(h.router.snapshot().layoutData).toEqual([{ from: "root" }, { from: "admin" }])
    h.settle("/admin/users")
    await tick(5)
    expect(h.router.snapshot().routeId).toBe("admin/users")
  })

  test("a loading page is skipped while a layout above it is not on screen", async () => {
    // From `/` only the root layout is shared: `admin/_loading` sits under the admin layout, which
    // has no data yet, so the root page shows instead.
    const h = harness()
    await h.router.navigate("/admin/users")
    expect(chainOf(h)).toEqual([Root, RootLoading])
    h.settle("/admin/users")
    await tick(5)
  })

  test("an outer loading page fills the page slot of every shared layout", async () => {
    const h = harness({
      initial: {
        routeId: "admin/index",
        path: "/admin",
        layoutData: [{ from: "root" }, { from: "admin" }],
      },
      routes: {
        "admin/index": [["_layout", "admin/_layout"], [["_loading", 1]]],
        "admin/users": [["_layout", "admin/_layout"], [["_loading", 1]]],
      },
    })
    await h.router.navigate("/admin/users")
    // The admin layout stays mounted; the root page takes the slot inside it.
    expect(chainOf(h)).toEqual([Root, Admin, RootLoading])
    h.settle("/admin/users")
    await tick(5)
  })

  test("with no eligible loading page the current page stays", async () => {
    const h = harness({
      routes: {
        index: [["_layout"], []],
        "admin/users": [["_layout", "admin/_layout"], [["admin/_loading", 2]]],
      },
    })
    const done = h.router.navigate("/admin/users")
    await tick(20)
    expect(h.router.snapshot().routeId).toBe("index")
    expect(h.router.snapshot().pending).toBe(true)
    expect(h.imported).toEqual([])
    h.settle("/admin/users")
    await done
    expect(h.router.snapshot().routeId).toBe("admin/users")
  })

  test("a search change on the same pathname keeps the page", async () => {
    const h = harness()
    const done = h.router.navigate("/?page=2")
    await tick(20)
    expect(h.router.snapshot().routeId).toBe("index")
    h.settle("/?page=2")
    await done
    expect(h.router.snapshot().path).toBe("/?page=2")
  })

  test("a submit never shows a loading page", async () => {
    const h = harness()
    const fetchBackup = globalThis.fetch
    let release: ((response: Response) => void) | undefined
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve
      })) as unknown as typeof fetch
    try {
      const done = h.router.submit("/", new FormData(), { revalidate: false })
      await tick(20)
      expect(h.router.snapshot().routeId).toBe("index")
      expect(h.router.snapshot().pending).toBe(true)
      release?.(new Response("null", { headers: { "content-type": "application/json" } }))
      await done
    } finally {
      globalThis.fetch = fetchBackup
    }
    expect(h.router.snapshot().routeId).toBe("index")
  })

  test("a failure before the loading page shows rejects, as the bare router does", async () => {
    const h = harness({ delayMs: 40 })
    const done = h.router.navigate("/about")
    h.fail("/about")
    await expect(done).rejects.toThrow("fetch failed")
    expect(h.fellBack).toEqual([])
    expect(h.router.snapshot().routeId).toBe("index")
  })

  test("a failure after the loading page shows goes to the fallback", async () => {
    const h = harness()
    await h.router.navigate("/about") // resolved: the caller is no longer waiting
    expect(chainOf(h)).toEqual([Root, RootLoading])
    h.fail("/about")
    await tick(5)
    expect(h.fellBack).toEqual(["/about"])
    // The page slot is the current page's again until the fallback takes over.
    expect(h.router.snapshot().routeId).toBe("index")
    expect(h.router.snapshot().pending).toBe(false)
  })

  test("a redirect out of the app after the loading page shows replaces the entry", async () => {
    const h = harness()
    const slot = globalThis as { location?: unknown }
    const saved = slot.location
    const replaced: string[] = []
    slot.location = { replace: (to: string) => replaced.push(to) }
    try {
      await h.router.navigate("/about")
      h.fail("/about", Object.assign(new Error("moved"), { redirectTo: "https://id.example/auth" }))
      await tick(5)
      expect(replaced).toEqual(["https://id.example/auth"])
      expect(h.fellBack).toEqual([])
    } finally {
      slot.location = saved
    }
  })

  test("a newer navigation with the same loading view keeps it on screen", async () => {
    const h = harness()
    await h.router.navigate("/about")
    const view = h.router.snapshot().routeId
    const seen: string[] = []
    h.router.subscribe(() => seen.push(h.router.snapshot().routeId))
    // Superseded: the first navigation's data is dropped, the view never flips back to the old page.
    const second = h.router.navigate("/admin")
    expect(h.router.snapshot().routeId).toBe(view)
    await second
    h.settle("/about")
    await tick(5)
    expect(h.router.snapshot().routeId).toBe(view)
    expect(h.router.snapshot().pendingPath).toBe("/admin")
    h.settle("/admin")
    await tick(5)
    expect(h.router.snapshot().routeId).toBe("admin/index")
    expect(seen.every((id) => id === view || id === "admin/index")).toBe(true)
  })

  test("a newer navigation with no loading page hands the slot back to the current page", async () => {
    const h = harness()
    await h.router.navigate("/about")
    expect(chainOf(h)).toEqual([Root, RootLoading])
    // Same pathname as the current page: it has no loading page, so the page itself shows, pending.
    const second = h.router.navigate("/?tab=2")
    expect(h.router.snapshot().routeId).toBe("index")
    expect(h.router.snapshot().pending).toBe(true)
    h.settle("/?tab=2")
    await second
    expect(h.router.snapshot().path).toBe("/?tab=2")
  })

  test("a superseded navigation's late failure cannot replace the newer page", async () => {
    const h = harness()
    await h.router.navigate("/about")
    const second = h.router.navigate("/admin")
    h.settle("/admin")
    await second
    h.fail("/about")
    await tick(5)
    expect(h.fellBack).toEqual([])
    expect(h.router.snapshot().routeId).toBe("admin/index")
    expect(h.router.snapshot().path).toBe("/admin")
  })

  test("a superseded navigation's failure leaves the newer loading view pending", async () => {
    const h = harness()
    await h.router.navigate("/about")
    await h.router.navigate("/admin")
    const view = h.router.snapshot().routeId
    h.fail("/about")
    await tick(5)
    expect(h.fellBack).toEqual([])
    expect(h.router.snapshot().routeId).toBe(view)
    expect(h.router.snapshot().pendingPath).toBe("/admin")
    h.settle("/admin")
    await tick(5)
    expect(h.router.snapshot().routeId).toBe("admin/index")
  })

  test("a form submit cancels a navigation's loading view and stale fallback", async () => {
    const h = harness()
    await h.router.navigate("/about")
    expect(chainOf(h)).toEqual([Root, RootLoading])
    const fetchBackup = globalThis.fetch
    let release: ((response: Response) => void) | undefined
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve
      })) as unknown as typeof fetch
    try {
      const submitted = h.router.submit("/", new FormData(), { revalidate: false })
      await tick(5)
      expect(h.router.snapshot().routeId).toBe("index")
      h.fail("/about")
      await tick(5)
      expect(h.fellBack).toEqual([])
      release?.(new Response("null", { headers: { "content-type": "application/json" } }))
      await submitted
    } finally {
      globalThis.fetch = fetchBackup
    }
  })

  test("refreshing the active page cancels a navigation's loading view and fallback", async () => {
    const h = harness()
    await h.router.navigate("/about")
    const refreshed = h.router.invalidate()
    await tick(5)
    expect(h.router.snapshot().routeId).toBe("index")
    h.fail("/about")
    await tick(5)
    expect(h.fellBack).toEqual([])
    h.settle("/")
    await refreshed
    expect(h.router.snapshot().routeId).toBe("index")
  })

  test("invalidating an unrelated page leaves the pending loading view intact", async () => {
    const h = harness()
    await h.router.navigate("/about")
    const view = h.router.snapshot().routeId
    await h.router.invalidate(["/admin"])
    expect(h.router.snapshot().routeId).toBe(view)
    expect(h.router.snapshot().pendingPath).toBe("/about")
    h.settle("/about")
    await tick(5)
    expect(h.router.snapshot().routeId).toBe("about")
  })

  test("an unmatched path is ignored and leaves the loading page up", async () => {
    const h = harness()
    await h.router.navigate("/about")
    const view = h.router.snapshot().routeId
    await h.router.navigate("/nope")
    expect(h.router.snapshot().routeId).toBe(view)
    h.settle("/about")
    await tick(5)
    expect(h.router.snapshot().routeId).toBe("about")
  })

  test("a loading module that fails to load costs the loading page, not the navigation", async () => {
    const h = harness({ failModule: "_loading" })
    const done = h.router.navigate("/about")
    await tick(20)
    expect(h.router.snapshot().routeId).toBe("index")
    h.settle("/about")
    await done
    expect(h.router.snapshot().routeId).toBe("about")
    expect(h.fellBack).toEqual([])
  })

  test("prefetch warms the loading pages of the target, once", async () => {
    const h = harness()
    void h.router.prefetch("/admin/users")
    void h.router.prefetch("/admin/users")
    await tick(5)
    expect(h.imported.sort()).toEqual(["_loading", "admin/_loading"])
    h.settle("/admin/users")
  })

  test("a route the table does not know has no layouts and no loading page", async () => {
    // A terminal status page (`_404`) is on screen: nothing is shared with it.
    const h = harness({ initial: { routeId: "_404", path: "/gone", layoutData: undefined } })
    const done = h.router.navigate("/admin/users")
    await tick(20)
    expect(h.router.snapshot().routeId).toBe("_404")
    expect(h.imported).toEqual([])
    h.settle("/admin/users")
    await done
    expect(h.router.snapshot().routeId).toBe("admin/users")
  })

  test("a subscriber stops hearing about loading pages once it unsubscribes", async () => {
    const h = harness()
    let calls = 0
    const unsubscribe = h.router.subscribe(() => {
      calls++
    })
    unsubscribe()
    await h.router.navigate("/about")
    expect(calls).toBe(0)
    h.settle("/about")
    await tick(5)
  })
})

describe("the client build", () => {
  // Inside the workspace, so the generated bootstrap resolves `@nifrajs/web` through node_modules.
  const root = mkdtempSync(`${import.meta.dir}/.tmp-loading-`)
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("every page that can start a navigation links the loading pages' stylesheets", async () => {
    const files: Record<string, string> = {
      "routes/_layout.tsx":
        'import "../frontend/app.css"\nexport default function Layout() { return null }\n',
      "routes/_404.tsx": "export default function Missing() { return null }\n",
      "routes/index.tsx": "export default function Index() { return null }\n",
      "routes/admin/index.tsx": "export default function Admin() { return null }\n",
      "routes/admin/_loading.tsx":
        'import "../../frontend/skeleton.css"\nexport default function Skeleton() { return "loading-marker" }\n',
      "frontend/app.css": "body { color: rebeccapurple }\n",
      "frontend/skeleton.css": ".skeleton { color: tomato }\n",
      "frontend/client-stub.ts": "export function mountRouter() {}\n",
    }
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    const outDir = join(root, "dist", "assets")
    const manifest = await buildClient({
      routesDir: join(root, "routes"),
      outDir,
      clientModule: join(root, "frontend/client-stub.ts"),
      publicDir: false,
      minify: false,
    })

    // The layout's stylesheet, then the loading page's - on a page nowhere near `admin/`, too.
    for (const id of ["index", "admin/index"]) {
      const styles = manifest.routeStyles?.[id] ?? []
      expect(styles, id).toHaveLength(2)
      for (const url of styles) expect(manifest.css).toContain(url)
    }
    expect(manifest.routeStyles?._404).toHaveLength(1)
    // It is not a page the client navigates to, so it has no chunk list of its own.
    expect(Object.keys(manifest.routes).sort()).toEqual(["_404", "admin/index", "index"])
    // The loading page is built into the client output, and the bootstrap wraps the router with it.
    const emitted = readdirSync(outDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(outDir, name), "utf8"))
    expect(emitted.some((source) => source.includes("loading-marker"))).toBe(true)
    expect(emitted.some((source) => source.includes("admin/_loading"))).toBe(true)
  }, 60_000)
})
