import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { discoverRoutes } from "../src/fs.ts"
import { createViteDevServer, type ViteDevServer } from "../src/vite.ts"

const TMP_BASE = `${import.meta.dir}/.tmp-vite-dev-routes-`
let root: string
let routesDir: string
let server: ViteDevServer | undefined

beforeEach(() => {
  root = mkdtempSync(TMP_BASE)
  routesDir = join(root, "routes")
  mkdirSync(routesDir)
  writeFileSync(join(routesDir, "index.tsx"), "export default function Index() { return null }\n")
  writeFileSync(join(root, "client.ts"), "export function mountRouter() {}\n")
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

const page = async (): Promise<string> =>
  (await fetch(`http://127.0.0.1:${server?.port ?? 0}/`)).text()

const waitForPage = async (
  matches: (body: string) => boolean,
  timeoutMs = 15_000,
): Promise<string> => {
  // Vite's polling watcher is asynchronous. Leave room for a loaded full-suite CI runner to
  // deliver add/unlink events instead of turning a slow notification into a flaky assertion.
  const deadline = Date.now() + timeoutMs
  let body = await page()
  while (!matches(body) && Date.now() < deadline) {
    await Bun.sleep(50)
    body = await page()
  }
  return body
}

test("Vite route add and unlink events refresh both manifests without restart", async () => {
  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "client.ts"),
    port: 0,
    poll: true,
    createApp: () => {
      const ids = discoverRoutes(routesDir)
        .routes.map((route) => route.id)
        .sort()
      return { fetch: () => new Response(ids.join(",")) }
    },
  })
  expect(await page()).toBe("index")

  // Chokidar reports ready before Bun's fs.watchFile has taken its baseline stat of the directory, so a
  // route written in that gap is folded into the baseline and never reported. Until one probe route is
  // observed the poller may not have a baseline; a later probe changes the directory again past it.
  const probes: string[] = []
  for (let seen = false; !seen; ) {
    const probe = join(routesDir, `probe-${probes.length}.tsx`)
    writeFileSync(probe, "export default function Probe() { return null }\n")
    probes.push(probe)
    seen = (await waitForPage((body) => body.includes("probe"), 1_000)).includes("probe")
  }
  for (const probe of probes) rmSync(probe)
  expect(await waitForPage((body) => !body.includes("probe"))).toBe("index")

  const about = join(routesDir, "about.tsx")
  writeFileSync(about, "export default function About() { return null }\n")
  expect(await waitForPage((body) => body.includes("about"))).toContain("about")

  rmSync(about)
  expect(await waitForPage((body) => !body.includes("about"))).not.toContain("about")
}, 60_000)
