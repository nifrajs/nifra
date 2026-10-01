import { describe, expect, test } from "bun:test"
import * as client from "../src/client.ts"
import {
  buildManifest,
  createWebApp,
  generateClientEntry,
  type MountRouterOptions,
  type RenderAdapter,
  type RouteModule,
  redirect,
} from "../src/index.ts"
import { DATA_HEADER } from "../src/router.ts"
import { isBackendHalf, splitRouteHalves } from "./_route-halves.ts"

// `ssr = false`: the server renders everything around a page except the page's own component - its
// `HydrateFallback`, or nothing, fills the slot - and the browser hydrates that before it renders the
// component.

const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

const nameOf = (component: unknown): unknown =>
  typeof component === "function" ? `fn:${String((component as () => unknown)())}` : component

// Emits what was rendered as JSON, so a test reads the chain and the props back. A function in the
// chain is called and reported by its result: the empty leaf is `fn:null`.
const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(
      `<main>${JSON.stringify({
        chain: chain.map(nameOf),
        data: props.data,
        actionData: props.actionData ?? null,
        layoutData: props.layoutData ?? null,
      })}</main>`,
    ),
  hydrationHead: () => "",
}

interface Rendered {
  readonly chain: readonly unknown[]
  readonly data: unknown
  readonly actionData: unknown
  readonly layoutData: readonly unknown[] | null
}

const renderedOf = (html: string): Rendered => {
  const match = /<main>(.*?)<\/main>/s.exec(html)
  if (match === null) throw new Error(`no render in: ${html}`)
  return JSON.parse(match[1] as string) as Rendered
}

type Modules = Record<string, Partial<RouteModule>>

const manifestOf = (modules: Modules) =>
  buildManifest(Object.keys(splitRouteHalves(modules)), (file) => () => {
    const halves = splitRouteHalves(modules)
    return Promise.resolve(
      (isBackendHalf(file) ? halves[file] : { default: file, ...halves[file] }) as RouteModule,
    )
  })

const appOf = (modules: Modules) =>
  createWebApp({ adapter: stub, manifest: manifestOf(modules), clientEntry: "/c.js" })

const get = (
  app: { fetch(r: Request): Response | Promise<Response> },
  path: string,
  headers: Record<string, string> = {},
) => app.fetch(new Request(`http://x${path}`, { headers }))

describe("the server render of an ssr = false route", () => {
  test("puts HydrateFallback in the page slot, inside the layouts, with the loader data", async () => {
    const app = appOf({
      "_layout.tsx": { loader: () => ({ from: "layout" }) },
      "map.tsx": { ssr: false, HydrateFallback: "skeleton", loader: () => ({ pins: 3 }) },
    })
    const res = await get(app, "/map")
    expect(res.status).toBe(200)
    const html = await res.text()
    const rendered = renderedOf(html)
    expect(rendered.chain).toEqual(["_layout.tsx", "skeleton"])
    // The loader ran, its data reached the fallback and is embedded for the browser.
    expect(rendered.data).toEqual({ pins: 3 })
    expect(rendered.layoutData).toEqual([{ from: "layout" }])
    expect(html).toContain('"__NIFRA_DATA__":{"pins":3}')
    // The page still hydrates: the client entry ships.
    expect(html).toContain('<script type="module" src="/c.js">')
  })

  test("renders an empty leaf without a HydrateFallback", async () => {
    const app = appOf({ "_layout.tsx": {}, "map.tsx": { ssr: false } })
    const rendered = renderedOf(await (await get(app, "/map")).text())
    expect(rendered.chain).toEqual(["_layout.tsx", "fn:null"])
  })

  test("leaves every other route, and ssr = true, rendering its component", async () => {
    const app = appOf({
      "index.tsx": {},
      "on.tsx": { ssr: true, HydrateFallback: "unused" },
      "map.tsx": { ssr: false },
    })
    expect(renderedOf(await (await get(app, "/")).text()).chain).toEqual(["index.tsx"])
    expect(renderedOf(await (await get(app, "/on")).text()).chain).toEqual(["on.tsx"])
  })

  test("answers a data request exactly as an ssr route does", async () => {
    const app = appOf({ "map.tsx": { ssr: false, loader: () => ({ pins: 3 }) } })
    const res = await get(app, "/map", { [DATA_HEADER]: "1" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pins: 3 })
  })

  test("still runs the loader's control flow", async () => {
    const app = appOf({
      "map.tsx": {
        ssr: false,
        loader: () => {
          throw redirect("/login")
        },
      },
    })
    const res = await get(app, "/map")
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/login")
  })

  test("renders the fallback for the document an action answers with", async () => {
    const app = appOf({
      "map.tsx": {
        ssr: false,
        HydrateFallback: "skeleton",
        loader: () => ({ pins: 3 }),
        action: () => ({ saved: true }),
      },
    })
    const res = await app.fetch(
      new Request("http://x/map", {
        method: "POST",
        headers: { origin: "http://x", "content-type": "application/x-www-form-urlencoded" },
        body: "a=1",
      }),
    )
    const rendered = renderedOf(await res.text())
    expect(rendered.chain).toEqual(["skeleton"])
    expect(rendered.actionData).toEqual({ saved: true })
  })

  test("refuses ssr = false together with hydrate = false", async () => {
    const logged: string[] = []
    const log = (message: string, fields?: Record<string, unknown>): void => {
      logged.push(`${message} ${String(fields?.detail)}`)
    }
    const app = createWebApp({
      adapter: stub,
      manifest: manifestOf({ "map.tsx": { ssr: false, hydrate: false } }),
      clientEntry: "/c.js",
      server: { logger: { debug: log, info: log, warn: log, error: log } },
    })
    const res = await get(app, "/map")
    expect(res.status).toBe(500)
    // Nothing of the page is served: neither half would ever render its component.
    expect(await res.text()).not.toContain("<main>")
    expect(logged.join("\n")).toContain('route "map" sets both `ssr = false` and `hydrate = false`')
  })
})

// ---------------------------------------------------------------------------------------------------
// The generated client entry, executed: the real emitted source, with its imports bound to the real
// client runtime and a stub adapter.
// ---------------------------------------------------------------------------------------------------

type ClientModules = Record<string, Record<string, unknown>>

interface Mounted {
  readonly options: MountRouterOptions
  /** Every route id the view reported, in order: the mount-time one, then one per notification. */
  readonly seen: string[]
  readonly unsubscribe: () => void
}

const runEntry = async (
  modules: ClientModules,
  path: string,
  adapter: Record<string, unknown> = {},
): Promise<Mounted> => {
  const manifest = buildManifest(
    Object.keys(modules),
    (file) => () => Promise.resolve({ default: file } as RouteModule),
  )
  const source = generateClientEntry(manifest, {
    clientModule: "./adapter",
    resolve: (file) => file,
  })
  const body = source
    .replace(/^import \{([^}]+)\} from "@nifrajs\/web\/client"$/gm, "const {$1} = __client")
    .replace(/^import \* as __adapter from .*$/m, "")
    .replaceAll("import.meta.hot", "undefined")
    .replaceAll("import(", "__import(")
  // If the entry grows an import this harness does not bind, fail here rather than at `new Function`.
  expect(body).not.toMatch(/^import /m)

  let resolveMounted: (mounted: Mounted) => void = () => {}
  const mounted = new Promise<Mounted>((resolve) => {
    resolveMounted = resolve
  })
  const runtime = {
    ...client,
    installHistory: () => () => {},
    installForms: () => () => {},
    applyHead: () => {},
    signalHydrated: () => {},
    currentDocumentNonce: () => undefined,
    waitForStyles: () => Promise.resolve(),
  }
  const mountRouter = (options: MountRouterOptions): void => {
    const seen = [options.router.snapshot().routeId]
    const unsubscribe = options.router.subscribe(() => {
      seen.push(options.router.snapshot().routeId)
    })
    resolveMounted({ options, seen, unsubscribe })
  }
  const url = new URL(path, "http://x")
  new Function(
    "__client",
    "__adapter",
    "__import",
    "window",
    "document",
    "location",
    "requestAnimationFrame",
    body,
  )(
    runtime,
    { mountRouter, ...adapter },
    (file: string) => Promise.resolve({ default: file, ...modules[file] }),
    {},
    { querySelector: () => ({}), getElementById: () => ({}) },
    { pathname: url.pathname, search: url.search, origin: url.origin },
    () => 0,
  )
  return mounted
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const HELD = "\0ssr"

describe("the generated client entry", () => {
  test("hydrates an ssr = false page on its fallback chain, then hands over the route", async () => {
    const { options, seen } = await runEntry(
      {
        "_layout.tsx": { searchSchema: "layout-schema" },
        "map.tsx": { ssr: false, HydrateFallback: "skeleton", searchSchema: "page-schema" },
      },
      "/map?zoom=2",
    )
    const { router, routes, searchSchemas } = options

    // What the adapter hydrates: the server's chain, under an id no route file can produce.
    const first = router.snapshot()
    expect(first.routeId).toBe(HELD)
    expect(routes[HELD]).toEqual(["_layout.tsx", "skeleton"])
    expect(searchSchemas?.[HELD] as readonly unknown[]).toEqual(["layout-schema", "page-schema"])
    // Everything else about the state is the route's own.
    expect(first.path).toBe("/map?zoom=2")
    expect(first.pending).toBe(false)
    // A store hands back a stable reference between changes.
    expect(router.snapshot()).toBe(first)

    await macrotask()
    // One notification, and the view now names the real route and its real chain.
    expect(seen).toEqual([HELD, "map"])
    expect(router.snapshot().routeId).toBe("map")
    expect(routes.map).toEqual(["_layout.tsx", "map.tsx"])
  })

  test("uses an empty leaf when the page has no HydrateFallback", async () => {
    const { options } = await runEntry({ "_layout.tsx": {}, "map.tsx": { ssr: false } }, "/map")
    const chain = options.routes[HELD] as readonly unknown[]
    expect(chain).toHaveLength(2)
    expect(chain[0]).toBe("_layout.tsx")
    expect((chain[1] as () => unknown)()).toBeNull()
  })

  test("keeps the error boundary in the held chain", async () => {
    const boundary = (fallback: unknown): string => `boundary(${String(fallback)})`
    const { options } = await runEntry(
      {
        "_layout.tsx": {},
        "_error.tsx": {},
        "map.tsx": { ssr: false, HydrateFallback: "skeleton" },
      },
      "/map",
      { errorBoundary: boundary },
    )
    expect(options.routes[HELD]).toEqual(["_layout.tsx", "boundary(_error.tsx)", "skeleton"])
    expect(options.routes.map).toEqual(["_layout.tsx", "boundary(_error.tsx)", "map.tsx"])
  })

  test("a listener removed before the handover is not called", async () => {
    const { seen, unsubscribe } = await runEntry({ "map.tsx": { ssr: false } }, "/map")
    unsubscribe()
    await macrotask()
    expect(seen).toEqual([HELD])
  })

  test("mounts an ordinary page on the router itself", async () => {
    const { options, seen } = await runEntry({ "index.tsx": {}, "map.tsx": { ssr: false } }, "/")
    expect(options.router.snapshot().routeId).toBe("index")
    expect(HELD in options.routes).toBe(false)
    await macrotask()
    expect(seen).toEqual(["index"])
  })

  test("renders the component directly on a client navigation to an ssr = false page", async () => {
    const { options, seen } = await runEntry(
      { "index.tsx": {}, "map.tsx": { ssr: false, HydrateFallback: "skeleton" } },
      "/",
    )
    const fetched = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("null", {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    try {
      await options.router.navigate("/map")
    } finally {
      globalThis.fetch = fetched
    }
    expect(options.router.snapshot().routeId).toBe("map")
    expect(options.routes.map).toEqual(["map.tsx"])
    expect(seen).not.toContain(HELD)
  })
})
