import { rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import type { BunPlugin } from "bun"
import { discoverRoutes } from "../src/fs.ts"
import { createWebApp, generateClientEntry, type RenderAdapter } from "../src/index.ts"
import { DATA_HEADER } from "../src/router.ts"

export const HOLD_PATH = "/__test/hold-data"
export const RELEASE_PATH = "/__test/release-data"

/**
 * Serves a fixture app the way a build does: the generated client entry for its routes, bundled for
 * the browser, behind `createWebApp`'s server render. The app's directory needs a `package.json` of its
 * own, so the adapter package's `sideEffects: false` does not empty the bundle.
 */
export async function serveApp(options: {
  readonly appDir: string
  readonly adapter: RenderAdapter
  readonly clientModule: string
  readonly plugins?: readonly BunPlugin[]
  readonly mode?: "production" | "development"
}): Promise<{
  readonly url: string
  readonly stop: () => void
  /** Hold every data response until the returned function runs (also `HOLD_PATH` / `RELEASE_PATH`). */
  readonly holdData: () => () => void
}> {
  const routesDir = join(options.appDir, "routes")
  const manifest = discoverRoutes(routesDir)
  const entryPath = join(options.appDir, ".entry.ts")
  const source = generateClientEntry(manifest, {
    clientModule: options.clientModule,
    resolve: (file) => `./${relative(dirname(entryPath), join(routesDir, file))}`,
  })
  writeFileSync(entryPath, `globalThis.process ??= { env: {} };\n${source}`)
  let script: string
  try {
    const built = await Bun.build({
      entrypoints: [entryPath],
      target: "browser",
      conditions: ["bun", "browser"],
      define: { "process.env.NODE_ENV": JSON.stringify(options.mode ?? "production") },
      plugins: [...(options.plugins ?? [])],
    })
    if (!built.success) throw new Error(built.logs.map(String).join("\n"))
    script = (await built.outputs[0]?.text()) ?? ""
  } finally {
    rmSync(entryPath, { force: true })
  }
  const app = createWebApp({ adapter: options.adapter, manifest, clientEntry: "/entry.js" })
  let held: Promise<void> | undefined
  const hold = (): (() => void) => {
    let release = (): void => {}
    held = new Promise<void>((resolve) => {
      release = () => {
        held = undefined
        resolve()
      }
    })
    return release
  }
  let releaseHeld = (): void => {}
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname
      if (pathname === "/entry.js") {
        return new Response(script, { headers: { "content-type": "text/javascript" } })
      }
      // The same hold, for a test that serves the app from a child process.
      if (pathname === HOLD_PATH) {
        releaseHeld = hold()
        return new Response(null, { status: 204 })
      }
      if (pathname === RELEASE_PATH) {
        releaseHeld()
        return new Response(null, { status: 204 })
      }
      if (request.headers.has(DATA_HEADER) && held !== undefined) await held
      return app.fetch(request)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    holdData: hold,
  }
}
