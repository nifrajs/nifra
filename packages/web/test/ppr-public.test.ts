import { expect, test } from "bun:test"
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
    experimental: { ppr: partialPrerendering({ shellChecks: "unchecked-development" }) },
  })
}

test("pprShells reaches an app's shell cache, and refuses an app without experimental.ppr", async () => {
  expect(() => pprShells(appOf(false))).toThrow("created without experimental.ppr")
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
    experimental: {
      ppr: partialPrerendering({
        shellChecks: "unchecked-development",
        options: { shellAfterRequests, shellStoreBytes: 100_000 },
      }),
    },
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
