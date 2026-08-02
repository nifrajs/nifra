import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { reactAdapter } from "@nifrajs/web-react"
import { discoverRoutes } from "../src/fs.ts"
import { createWebApp } from "../src/index.ts"
import { createViteDevServer, type ViteDevServer } from "../src/vite.ts"
import { linkWorkspacePackages } from "./workspace-link.ts"

/**
 * The routing hooks must be SSR-correct IN DEV, not just in the production pipeline.
 *
 * The dev server is the one place two module resolvers share a process: the app's server code (the
 * adapter passed to `createWebApp`) is imported by Bun, while route modules load through Vite's SSR
 * runner - and Vite's SSR half resolves independently of `resolve.conditions`. That evaluated
 * `@nifrajs/web-react` twice, so `compose` provided one `RouterContext` while `useSearch`/`useParams`
 * read another, and every routing hook SSR-rendered its empty default in dev - `useSearch()` gave `{}`
 * while the SAME request's loader saw the validated values. The context is now a `globalThis`
 * singleton, and this test is what proves the two halves agree end-to-end: a real React route, a real
 * Vite dev server, and the hook's value asserted in the served HTML against the loader's.
 */

const TMP_BASE = `${import.meta.dir}/.tmp-vite-dev-search-`
let root: string | undefined
let server: ViteDevServer | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

test("useSearch and the loader see the same validated search on a dev SSR render", async () => {
  root = mkdtempSync(TMP_BASE)
  const routesDir = join(root, "routes")
  mkdirSync(routesDir)
  linkWorkspacePackages(root, ["web", "web-react"])
  writeFileSync(
    join(routesDir, "shop.tsx"),
    `import { useSearch } from "@nifrajs/web-react/router"
export const searchSchema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: { sku: value?.sku ?? "MISSING" } }),
  },
}
export function loader(ctx) {
  return { loaderSearch: ctx.search }
}
export default function Shop({ data }) {
  const search = useSearch()
  return (
    <main>
      <p id="loader">{JSON.stringify(data.loaderSearch)}</p>
      <p id="hook">{JSON.stringify(search)}</p>
    </main>
  )
}
`,
  )

  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: "@nifrajs/web-react/client",
    port: 0,
    createApp: (clientEntry, load) =>
      createWebApp({
        adapter: reactAdapter,
        manifest: discoverRoutes(routesDir, { load }),
        clientEntry,
      }),
  })

  const res = await fetch(`http://127.0.0.1:${server.port}/shop?sku=gemstone-0`)
  expect(res.status).toBe(200)
  const html = await res.text()
  const grab = (id: string): string | undefined =>
    html.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</p>`))?.[1]?.replace(/<!-- -->/g, "")
  const expected = "{&quot;sku&quot;:&quot;gemstone-0&quot;}"
  expect(grab("loader")).toBe(expected)
  // The hook's SSR output must EQUAL the loader's - `{}` here is the dual-module-instance regression.
  expect(grab("hook")).toBe(expected)
}, 60_000)
