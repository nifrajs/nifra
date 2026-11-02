import { expect, spyOn, test } from "bun:test"
import { contextStorage, getContext } from "@nifrajs/middleware/context-storage"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import {
  checkShellCanaries,
  defineShellLoader,
  PPR_DEFAULTS,
  partialPrerendering,
  pprShells,
} from "../src/ppr.ts"

const adapter: RenderAdapter = {
  renderToStream: () => new ReadableStream(),
  renderToString: () => '<main><div data-nifra-hole="a" aria-busy="true"></div></main>',
  hydrationHead: () => "",
  renderFragment: () => "<p>a</p>",
}

const appOf = (ppr: boolean, onShell = () => {}) => {
  const manifest: Manifest = {
    routes: [
      {
        id: "p",
        pattern: "/p",
        layoutIds: [],
        file: "p.tsx",
        load: async () => ({
          default: "page",
          shellLoader: defineShellLoader(() => {
            onShell()
            return {}
          }),
          revalidateTags: ["catalog"],
          boundaries: [
            { name: "a", mode: "dynamic", render: () => "", fallback: "loading", load: () => 1 },
          ],
        }),
      },
    ],
    layouts: {},
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  if (!ppr) return createWebApp({ adapter, manifest, clientEntry: "/c.js" })
  return createWebApp({
    adapter,
    manifest,
    clientEntry: "/c.js",
    ppr: partialPrerendering({ shellChecks: "unchecked-development" }),
  })
}

test("pprShells reaches an app's shell cache, and refuses an app without ppr", async () => {
  expect(() => pprShells(appOf(false))).toThrow("created without ppr")
  let builds = 0
  const app = appOf(true, () => {
    builds++
  })
  const shells = pprShells(app)
  const visit = async () => (await app.fetch(new Request("http://x/p"))).text()
  expect(await visit()).toContain('id="nifra-ppr:a"')
  await visit()
  expect(builds).toBe(1)
  shells.invalidateTag("other")
  await visit()
  expect(builds).toBe(1)
  shells.invalidateTag("catalog")
  await visit()
  expect(builds).toBe(2)
  expect(shells.stats()).toMatchObject({ slowAborted: 0, unsentBytes: 0 })
})

test("the documented defaults are the ones a deployment overrides", () => {
  expect(PPR_DEFAULTS.holeTimeoutMs).toBe(5_000)
  expect(PPR_DEFAULTS.maxHoleTimeoutMs).toBe(30_000)
  expect(Object.isFrozen(PPR_DEFAULTS)).toBe(true)
})

test.each([
  1, 3,
])("the canary check finds visitor data kept in module state, and passes a shell that keeps none (shell on request %d)", async (shellAfterRequests) => {
  // App code that stores the visitor where a shell loader reads it: no import check sees this.
  const current = { visitor: "" }
  const page = (data: unknown) =>
    `<main>${JSON.stringify(data)}<div data-nifra-hole="a" aria-busy="true"></div></main>`
  const shellLoaders: Readonly<Record<string, () => unknown>> = {
    "/leaky": () => ({ who: current.visitor }),
    "/clean": () => ({ who: "everyone" }),
    // Over half the store, so once it is kept the store counts as full and later shells wait.
    "/filler": () => ({ blob: "x".repeat(40_000) }),
  }
  const app = createWebApp({
    adapter: {
      ...adapter,
      renderToString: (_chain, props) => page(props.data),
      // A page with no shell yet streams whole, with its hole as a deferred value.
      renderToStream: (_chain, props) =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(page(props.data)))
            controller.close()
          },
        }),
    },
    manifest: {
      routes: Object.entries(shellLoaders).map(([pattern, shellLoader]) => ({
        id: pattern.slice(1),
        pattern,
        layoutIds: [],
        file: `${pattern.slice(1)}.tsx`,
        load: async () => ({
          default: "page",
          shellLoader,
          boundaries: [
            { name: "a", mode: "dynamic", render: () => "", fallback: "loading", load: () => 1 },
          ],
        }),
      })),
      layouts: {},
      notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
    },
    clientEntry: "/c.js",
    ppr: partialPrerendering({
      shellChecks: "unchecked-development",
      options: { shellAfterRequests, shellStoreBytes: 100_000 },
    }),
  })
  await (await app.fetch(new Request("http://localhost/filler"))).text()
  const withMiddleware = {
    fetch: (request: Request) => {
      current.visitor = `${request.headers.get("cookie")} ${request.headers.get("x-nifra-canary")}`
      return app.fetch(request)
    },
  }
  expect(await checkShellCanaries(withMiddleware, ["/leaky", "/clean"])).toEqual([
    { path: "/leaky", via: "cookie" },
    { path: "/leaky", via: "header" },
  ])
})

test("the cancel beacon is refused past 64 bytes, whatever its Content-Length claims", async () => {
  const app = appOf(true)
  const post = (body: string, length = String(body.length)) =>
    app.fetch(
      new Request("http://x/__nifra/ppr/cancel", {
        method: "POST",
        headers: { "content-length": length },
        body,
      }),
    )
  expect((await post("t".repeat(22))).status).toBe(204)
  expect((await post("t".repeat(65))).status).toBe(400)
  expect((await post("t".repeat(1_000), "22")).status).toBe(400)
})

const sharedApp = (
  shellLoaders: Readonly<Record<string, () => unknown>>,
  priceOf: () => unknown,
  use: NonNullable<Parameters<typeof createWebApp>[0]["use"]> = () => {},
  cartOf: () => unknown = () => 1,
) => {
  const page = (props: { readonly data: unknown; readonly boundaries?: object }) =>
    `<main>${JSON.stringify(props.data)}${Object.keys(props.boundaries ?? {})
      .map((name) => `<div data-nifra-hole="${name}" aria-busy="true"></div>`)
      .join("")}</main>`
  const app = createWebApp({
    use,
    adapter: {
      ...adapter,
      renderToString: (_chain, props) => page(props),
      renderToStream: (_chain, props) =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(page(props)))
            controller.close()
          },
        }),
      renderFragment: (ui) => `<p>${String(ui())}</p>`,
    },
    manifest: {
      routes: Object.entries(shellLoaders).map(([pattern, shellLoader]) => ({
        id: pattern.slice(1),
        pattern,
        layoutIds: [],
        file: `${pattern.slice(1)}.tsx`,
        load: async () => ({
          default: "page",
          shellLoader,
          boundaries: [
            {
              name: "price",
              mode: "shared",
              revalidate: 60,
              render: (data: unknown) => JSON.stringify(data),
              fallback: "loading",
              load: priceOf,
            },
            {
              name: "cart",
              mode: "dynamic",
              render: (data: unknown) => JSON.stringify(data),
              fallback: "loading",
              load: cartOf,
            },
          ],
        }),
      })),
      layouts: {},
      notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
    },
    clientEntry: "/c.js",
    ppr: partialPrerendering({ shellChecks: "unchecked-development" }),
  })
  return app
}

test("the canary check finds visitor data a shared hole's loader read from module state", async () => {
  const current = { visitor: "" }
  const app = sharedApp({ "/leaky": () => ({ shell: "clean" }) }, () => ({ who: current.visitor }))
  const withMiddleware = {
    fetch: (request: Request) => {
      current.visitor = `${request.headers.get("cookie")}`
      return app.fetch(request)
    },
  }
  expect(await checkShellCanaries(withMiddleware, ["/leaky"])).toEqual([
    { path: "/leaky", via: "cookie", hole: "price" },
  ])
})

test("a request helper throws in a shared hole's loader, which shows its error; a per-visitor one reads it", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const app = sharedApp(
      { "/p": () => ({}) },
      () => ({ path: getContext().req.url }),
      (created) => {
        created.use(contextStorage())
      },
      () => ({ path: new URL(getContext().req.url).pathname }),
    )
    const html = await (await app.fetch(new Request("http://x/p"))).text()
    expect(html).toContain(
      '<script type="application/json" id="nifra-ppr:price">{"v":1,"error":true,"html":"<p data-nifra-hole-error=\\"\\">This section is unavailable.<\\/p>"}</script>',
    )
    expect(html).toContain(
      '<script type="application/json" id="nifra-ppr:cart">{"v":1,"html":"<p>{\\"path\\":\\"/p\\"}<\\/p>"}</script>',
    )
    expect(errors).toHaveBeenCalledWith("[nifra/web] ppr: shared hole build failed", {
      route: "p",
      hole: "price",
      kind: "error",
    })
  } finally {
    errors.mockRestore()
  }
})
