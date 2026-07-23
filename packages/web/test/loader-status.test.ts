import { expect, test } from "bun:test"
import {
  createWebApp,
  gone,
  type Manifest,
  notFound,
  type RenderAdapter,
  redirect,
  statusPage,
} from "../src/index.ts"
import { DATA_HEADER, STATUS_HEADER } from "../src/router.ts"

const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(`<p>chain=${chain.length}:${JSON.stringify(chain)}:${JSON.stringify(props.data)}</p>`),
  hydrationHead: () => "",
}

/** A manifest whose one route's loader throws whatever the test supplies. */
const manifestWith = (loader: () => unknown, extra: Partial<Manifest> = {}): Manifest =>
  ({
    routes: [
      {
        id: "jobs/[id]",
        pattern: "/jobs/:id",
        layoutIds: [],
        file: "jobs/[id].tsx",
        load: async () => ({ default: "job", loader }),
      },
    ],
    layouts: {},
    notFound: { file: "_404.tsx", load: async () => ({ default: "the-404-page" }) },
    ...extra,
  }) as Manifest

const get = (app: { fetch(r: Request): Response | Promise<Response> }, path = "/jobs/7") =>
  app.fetch(new Request(`http://x${path}`))

test("a loader throwing notFound() renders the _404 page at 404, not a 200 shell", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith(() => notFound()),
    clientEntry: "/c.js",
  })
  const res = await get(app)

  // The whole point: the status is 404, so a crawler drops the URL instead of indexing a "not found"
  // page served as a success.
  expect(res.status).toBe(404)
  const html = await res.text()
  expect(html).toContain("the-404-page")
  expect(html).toContain("chain=1")
})

test("gone() answers 410, and prefers _410 over _404 when the app authored one", async () => {
  const withPage = createWebApp({
    adapter: stub,
    manifest: manifestWith(() => gone(), {
      statusPages: { "410": { file: "_410.tsx", load: async () => ({ default: "the-410-page" }) } },
    }),
    clientEntry: "/c.js",
  })
  const res = await get(withPage)
  expect(res.status).toBe(410)
  expect(await res.text()).toContain("the-410-page")

  // With no _410 authored it still answers 410 — only the page falls back.
  const fallback = createWebApp({
    adapter: stub,
    manifest: manifestWith(() => gone()),
    clientEntry: "/c.js",
  })
  const res2 = await get(fallback)
  expect(res2.status).toBe(410)
  expect(await res2.text()).toContain("the-404-page")
})

test("statusPage() covers any 4xx/5xx and rejects everything else at the call site", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith(() => statusPage(451)),
    clientEntry: "/c.js",
  })
  expect((await get(app)).status).toBe(451)

  // 3xx belongs to redirect(), 2xx is a successful render — neither is a terminal status, and
  // silently accepting them would produce a page nobody can explain.
  expect(() => statusPage(302)).toThrow(/4xx or 5xx/)
  expect(() => statusPage(200)).toThrow(/4xx or 5xx/)
  expect(() => statusPage(404.5)).toThrow(/4xx or 5xx/)
})

test("with no _404 authored, the signal still carries its status as plain text", async () => {
  const bare = manifestWith(() => notFound())
  const { notFound: _drop, ...withoutPage } = bare as Manifest & { notFound?: unknown }
  const app = createWebApp({
    adapter: stub,
    manifest: withoutPage as Manifest,
    clientEntry: "/c.js",
  })
  const res = await get(app)
  expect(res.status).toBe(404)
  expect(res.headers.get("content-type")).toContain("text/plain")
  expect(await res.text()).toBe("Not Found")
})

test("headers ride along, so 404 and 410 can carry different cache policies", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith(() => gone({ headers: { "cache-control": "public, max-age=86400" } })),
    clientEntry: "/c.js",
  })
  const res = await get(app)
  expect(res.headers.get("cache-control")).toBe("public, max-age=86400")
  // A caller cannot mislabel the document by passing content-type through the same channel.
  expect(res.headers.get("content-type")).toContain("text/html")
})

test("a caller-supplied content-type cannot override the document's own", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith(() => notFound({ headers: { "content-type": "application/json" } })),
    clientEntry: "/c.js",
  })
  expect((await get(app)).headers.get("content-type")).toContain("text/html")
})

test("every pre-existing throw keeps its exact behaviour", async () => {
  // A hand-rolled Response is still served verbatim — this is what the brand check ahead of the
  // pass-through protects, and an app relying on it must not silently start getting the _404 page.
  const verbatim = createWebApp({
    adapter: stub,
    manifest: manifestWith(() => {
      throw new Response("my own body", { status: 404, headers: { "x-mine": "1" } })
    }),
    clientEntry: "/c.js",
  })
  const res = await get(verbatim)
  expect(res.status).toBe(404)
  expect(res.headers.get("x-mine")).toBe("1")
  expect(await res.text()).toBe("my own body")

  // redirect() is untouched.
  const red = createWebApp({
    adapter: stub,
    manifest: manifestWith(() => {
      throw redirect("/login")
    }),
    clientEntry: "/c.js",
  })
  const rres = await get(red)
  expect(rres.status).toBe(303)
  expect(rres.headers.get("location")).toBe("/login")
})

test("a client-side navigation gets the status on a header instead of a document", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: manifestWith(() => gone()),
    clientEntry: "/c.js",
  })
  const res = await app.fetch(new Request("http://x/jobs/7", { headers: { [DATA_HEADER]: "1" } }))
  // A soft-nav asked for DATA, so answering with the HTML document would be answering a different
  // question. The status is the answer, and the header is what lets the client act on it.
  expect(res.status).toBe(410)
  expect(res.headers.get(STATUS_HEADER)).toBe("410")
  expect(await res.text()).toBe("")
})

test("the signal brand does not leak into the response body or enumeration", async () => {
  // Symbol.for + non-enumerable: a structured clone or a JSON dump of the thrown Response must not
  // carry framework internals.
  let thrown: unknown
  try {
    notFound()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(Response)
  expect(Object.keys(thrown as object)).toEqual([])
  expect(JSON.stringify(thrown)).toBe("{}")
})

test("a prerendered path whose loader signals notFound() is omitted, not baked as a 200 shell", async () => {
  // A baked soft 404 is strictly worse than a runtime one: it is a static file that survives a
  // redeploy. `prerenderRoutes` skips any non-ok render, and a signal IS a non-ok render — this
  // pins that the two compose rather than needing a special case.
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { prerenderRoutes } = await import("../src/prerender.ts")

  const dir = mkdtempSync(join(tmpdir(), "nifra-loader-status-"))
  try {
    const app = createWebApp({
      adapter: stub,
      manifest: {
        routes: [
          {
            id: "gone-page",
            pattern: "/gone-page",
            layoutIds: [],
            file: "gone-page.tsx",
            load: async () => ({ default: "x", prerender: true, loader: () => notFound() }),
          },
        ],
        layouts: {},
        notFound: { file: "_404.tsx", load: async () => ({ default: "the-404-page" }) },
      } as Manifest,
      clientEntry: "/c.js",
    })
    const routes = [
      {
        id: "gone-page",
        pattern: "/gone-page",
        layoutIds: [],
        file: "gone-page.tsx",
        load: async () => ({ default: "x", prerender: true }),
      },
    ]
    const result = await prerenderRoutes({ app, routes: routes as never, outDir: dir })

    expect(existsSync(join(dir, "gone-page/index.html"))).toBe(false)
    expect(result.prerendered).toEqual([])
    expect(result.skipped).toEqual([{ path: "/gone-page", reason: "render returned HTTP 404" }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an SSR duplicate-instance error names the cause instead of only a React internal", async () => {
  // The failure being replaced: a 500 whose message points at a React internal, from which "two
  // copies at different paths" is hours of inference away.
  const app = createWebApp({
    adapter: stub,
    manifest: {
      routes: [
        {
          id: "hooky",
          pattern: "/hooky",
          layoutIds: [],
          errorIds: ["_error"],
          file: "hooky.tsx",
          load: async () => ({
            default: "x",
            loader: () => {
              throw new Error("null is not an object (evaluating 'resolveDispatcher().useId')")
            },
          }),
        },
      ],
      layouts: {},
      errors: { _error: { file: "_error.tsx", load: async () => ({ default: "boundary" }) } },
    } as Manifest,
    clientEntry: "/c.js",
  })
  const html = await (await app.fetch(new Request("http://x/hooky"))).text()
  expect(html).toContain("TWO COPIES")
  expect(html).toContain("nifra check")
  // Version-matching is the wrong fix and the message says so explicitly.
  expect(html).toContain("matching versions do NOT fix it")
})

test("an ordinary render error is left exactly as it was", async () => {
  const app = createWebApp({
    adapter: stub,
    manifest: {
      routes: [
        {
          id: "boom",
          pattern: "/boom",
          layoutIds: [],
          errorIds: ["_error"],
          file: "boom.tsx",
          load: async () => ({
            default: "x",
            loader: () => {
              throw new Error("database unreachable")
            },
          }),
        },
      ],
      layouts: {},
      errors: { _error: { file: "_error.tsx", load: async () => ({ default: "boundary" }) } },
    } as Manifest,
    clientEntry: "/c.js",
  })
  const html = await (await app.fetch(new Request("http://x/boom"))).text()
  expect(html).toContain("database unreachable")
  expect(html).not.toContain("TWO COPIES")
})
