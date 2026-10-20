import { expect, test } from "bun:test"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import { defineShellLoader, PPR_DEFAULTS, partialPrerendering, pprShells } from "../src/ppr.ts"

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
          boundaries: [{ name: "a", mode: "dynamic", render: () => "", load: () => 1 }],
        }),
      },
    ],
    layouts: {},
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  return createWebApp({
    adapter,
    manifest,
    clientEntry: "/c.js",
    ...(ppr
      ? { experimental: { ppr: partialPrerendering({ shellChecks: "unchecked-development" }) } }
      : {}),
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
