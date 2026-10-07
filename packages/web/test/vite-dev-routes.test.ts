import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
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

/** Both manifests at once: the app's route ids, and whether the client entry imports `about`. */
const manifests = async (): Promise<string> => {
  const entry = readFileSync(join(root, ".nifra-vite-entry.tsx"), "utf8")
  return `${await page()} | ${entry.includes("/routes/about.tsx") ? "about" : "-"}`
}

const waitForManifests = async (expected: string): Promise<string> => {
  // Vite's polling watcher is asynchronous. Leave room for a loaded full-suite CI runner to
  // deliver add/unlink events instead of turning a slow notification into a flaky assertion.
  const deadline = Date.now() + 15_000
  let seen = await manifests()
  while (seen !== expected && Date.now() < deadline) {
    await Bun.sleep(50)
    seen = await manifests()
  }
  return seen
}

const startPolling = async (plugins: readonly unknown[] = []): Promise<void> => {
  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "client.ts"),
    port: 0,
    poll: true,
    plugins,
    createApp: () => {
      const ids = discoverRoutes(routesDir)
        .routes.map((route) => route.id)
        .sort()
      return { fetch: () => new Response(ids.join(",")) }
    },
  })
}

test("Vite route add and unlink events refresh both manifests without restart", async () => {
  await startPolling()
  expect(await manifests()).toBe("index | -")

  const about = join(routesDir, "about.tsx")
  writeFileSync(about, "export default function About() { return null }\n")
  expect(await waitForManifests("about,index | about")).toBe("about,index | about")

  rmSync(about)
  expect(await waitForManifests("index | -")).toBe("index | -")
}, 60_000)

test("a polled route add or unlink the watcher never reports still refreshes both manifests", async () => {
  // Stands in for the poller's late baseline: a change folded into it is never reported, exactly as
  // one in an ignored directory is not.
  const routesUnwatched = {
    name: "routes-unwatched",
    config: () => ({
      server: { watch: { ignored: [(path: string) => resolve(path).startsWith(routesDir)] } },
    }),
  }
  await startPolling([routesUnwatched])
  expect(await manifests()).toBe("index | -")

  const about = join(routesDir, "about.tsx")
  writeFileSync(about, "export default function About() { return null }\n")
  expect(await waitForManifests("about,index | about")).toBe("about,index | about")

  rmSync(about)
  expect(await waitForManifests("index | -")).toBe("index | -")
}, 60_000)
