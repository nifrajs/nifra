import { expect, test } from "bun:test"
import { createWebApp, type Manifest, notFound, type RenderAdapter } from "../src/index.ts"
import { DATA_HEADER } from "../src/router.ts"

const streamOf = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })

/** Serializes `layoutData` so the SERVER contract is assertable without touching a real adapter. */
const stub: RenderAdapter = {
  renderToStream: (_chain, props) =>
    streamOf(
      `<p>L=${JSON.stringify(props.layoutData ?? null)} D=${JSON.stringify(props.data)}</p>`,
    ),
  hydrationHead: () => "",
}

type LayoutMod = { default: unknown; loader?: unknown; gate?: boolean }

const appWith = (
  layouts: Record<string, LayoutMod>,
  layoutIds: string[],
  layoutParams: string[][],
  pageLoader?: () => unknown,
  pattern = "/orgs/:org/projects/:id",
) =>
  createWebApp({
    adapter: stub,
    manifest: {
      routes: [
        {
          id: "page",
          pattern,
          layoutIds,
          layoutParams,
          file: "page.tsx",
          load: async () => ({ default: "page", ...(pageLoader ? { loader: pageLoader } : {}) }),
        },
      ],
      layouts: Object.fromEntries(
        Object.entries(layouts).map(([id, mod]) => [
          id,
          { file: `${id}.tsx`, load: async () => mod },
        ]),
      ),
      notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
    } as unknown as Manifest,
    clientEntry: "/c.js",
  })

const body = async (
  app: { fetch(r: Request): Response | Promise<Response> },
  path = "/orgs/acme/projects/7",
) => await (await app.fetch(new Request(`http://x${path}`))).text()

test("a layout loader runs and its data lands at its own index", async () => {
  const app = appWith(
    {
      _layout: { default: "root", loader: () => ({ from: "root" }) },
      "orgs/[org]/_layout": { default: "org", loader: () => ({ from: "org" }) },
    },
    ["_layout", "orgs/[org]/_layout"],
    [[], ["org"]],
  )
  expect(await body(app)).toContain('L=[{"from":"root"},{"from":"org"}]')
})

test("a layout receives only the params it owns", async () => {
  // A layout at `orgs/[org]/` must not see `id` — that belongs to a route beneath it, and reading it
  // works right up until the layout is reused under a route that has no such param.
  const seen: Record<string, unknown> = {}
  const app = appWith(
    {
      _layout: {
        default: "root",
        loader: (ctx: { params: unknown }) => {
          seen.root = ctx.params
          return null
        },
      },
      "orgs/[org]/_layout": {
        default: "org",
        loader: (ctx: { params: unknown }) => {
          seen.org = ctx.params
          return null
        },
      },
    },
    ["_layout", "orgs/[org]/_layout"],
    [[], ["org"]],
  )
  await body(app)
  expect(seen).toEqual({ root: {}, org: { org: "acme" } })
})

test("a layout without a loader contributes null, keeping the array aligned", async () => {
  const app = appWith(
    {
      _layout: { default: "root" },
      "orgs/[org]/_layout": { default: "org", loader: () => ({ from: "org" }) },
    },
    ["_layout", "orgs/[org]/_layout"],
    [[], ["org"]],
  )
  // Index 0 is null, NOT dropped — misalignment would render one layout's data inside another.
  expect(await body(app)).toContain('L=[null,{"from":"org"}]')
})

test("no layout loader anywhere ⇒ no layoutData at all", async () => {
  const app = appWith({ _layout: { default: "root" } }, ["_layout"], [[]], () => ({ page: 1 }))
  // Absent, not an array of nulls: a page-only app must serialize nothing extra.
  expect(await body(app)).toContain("L=null")
})

test("without `gate`, the page loader runs in parallel with the layout loader", async () => {
  // Asserted so the documentation is honest rather than aspirational: this is exactly why a
  // non-gated layout loader is NOT an authorization boundary.
  const order: string[] = []
  let releaseLayout: () => void = () => {}
  const layoutBlocked = new Promise<void>((r) => {
    releaseLayout = r
  })
  const app = appWith(
    {
      _layout: {
        default: "root",
        loader: async () => {
          order.push("layout:start")
          await layoutBlocked
          order.push("layout:end")
          return null
        },
      },
    },
    ["_layout"],
    [[]],
    () => {
      order.push("page")
      releaseLayout()
      return { page: 1 }
    },
  )
  await body(app)
  // The page ran while the layout was still suspended — the parallel default, stated plainly.
  expect(order).toEqual(["layout:start", "page", "layout:end"])
})

test("`gate: true` blocks the page loader until it resolves", async () => {
  const order: string[] = []
  const app = appWith(
    {
      _layout: {
        default: "root",
        gate: true,
        loader: async () => {
          order.push("gate:start")
          await Promise.resolve()
          order.push("gate:end")
          return { ok: true }
        },
      },
    },
    ["_layout"],
    [[]],
    () => {
      order.push("page")
      return { page: 1 }
    },
  )
  await body(app)
  expect(order).toEqual(["gate:start", "gate:end", "page"])
})

test("a rejecting gate stops the page loader from ever running", async () => {
  // The security property. With parallel execution the page would already have queried by the time
  // the guard said no.
  let pageRan = false
  const app = appWith(
    {
      _layout: {
        default: "root",
        gate: true,
        loader: () => notFound(),
      },
    },
    ["_layout"],
    [[]],
    () => {
      pageRan = true
      return { page: 1 }
    },
  )
  const res = await app.fetch(new Request("http://x/orgs/acme/projects/7"))
  expect(res.status).toBe(404)
  expect(pageRan).toBe(false)
})

test("a gate also runs on the data-only request", async () => {
  // Otherwise the guard is bypassed by sending the data header, which is exactly the request a
  // client navigation makes.
  let pageRan = false
  const app = appWith(
    { _layout: { default: "root", gate: true, loader: () => notFound() } },
    ["_layout"],
    [[]],
    () => {
      pageRan = true
      return { page: 1 }
    },
  )
  const res = await app.fetch(
    new Request("http://x/orgs/acme/projects/7", { headers: { [DATA_HEADER]: "1" } }),
  )
  expect(res.status).toBe(404)
  expect(pageRan).toBe(false)
})

test("a non-gate layout loader that rejects surfaces rather than going unhandled", async () => {
  const app = appWith(
    { _layout: { default: "root", loader: () => Promise.reject(new Error("layout blew up")) } },
    ["_layout"],
    [[]],
    () => ({ page: 1 }),
  )
  expect((await app.fetch(new Request("http://x/orgs/acme/projects/7"))).status).toBe(500)
})

test("a layout exporting an action still fails loudly", async () => {
  const app = appWith(
    { _layout: { default: "root", action: () => null } as LayoutMod },
    ["_layout"],
    [[]],
  )
  expect((await app.fetch(new Request("http://x/orgs/acme/projects/7"))).status).toBe(500)
})
