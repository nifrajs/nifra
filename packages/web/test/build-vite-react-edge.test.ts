import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildTargetVite } from "../src/build-vite.ts"
import { linkWorkspacePackages } from "./workspace-link.ts"

// The Vite production build's highest-risk claim: an EDGE server bundle (cf-pages / vercel) resolves
// react-dom/server's EDGE build under Vite, so a React app SSRs on workerd. The Bun path needs a shim for
// this (its `bun` condition contaminates react-dom's export map); Vite resolves it via the
// workerd/edge-light conditions instead, and THIS test is what proves that actually happens rather than
// resolving react-dom's node build (which would crash on the edge) or a second React core (the dual-React
// null-dispatcher crash). It builds a real React app, then RUNS the emitted edge worker in-process and
// asserts real SSR output — hook-driven markup and the scoped CSS-module class both present.
//
// A real React app is needed (react/react-dom + @vitejs/plugin-react resolve from the workspace), so this
// is heavier than the vanilla-adapter e2e; it is the one framework case worth paying for.

const TMP_BASE = `${import.meta.dir}/.tmp-vite-react-edge-`
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function scaffoldReactApp(): {
  root: string
  routesDir: string
  outDir: string
  workDir: string
  frameworkFile: string
  vitePlugins: readonly unknown[]
} {
  const root = mkdtempSync(TMP_BASE)
  dirs.push(root)
  const w = (rel: string, content: string) => {
    const p = join(root, rel)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, content)
  }
  w("framework.ts", 'export { reactAdapter as adapter } from "@nifrajs/web-react"\n')
  // A route with a real hook (useState) so the render exercises the dispatcher — the exact path that
  // throws if two React cores reach SSR — plus a CSS module so the edge build's CSS pipeline is covered.
  w(
    "routes/index.tsx",
    `import { useState } from "react"
     import styles from "./index.module.css"
     export default function Index() {
       const [n] = useState(41)
       return <h1 id="page" className={styles.title}>edge-react-{n}</h1>
     }\n`,
  )
  w("routes/index.module.css", ".title { color: rebeccapurple }\n")
  // `@nifrajs/web-react` (adapter + `/client`) and the packages the generated entry imports are bare
  // specifiers, resolved from the app's own node_modules exactly as a real install provides them.
  linkWorkspacePackages(root, ["web", "core", "node", "client", "web-react"])
  return {
    root,
    routesDir: join(root, "routes"),
    outDir: join(root, "deploy"),
    workDir: join(root, ".work"),
    frameworkFile: join(root, "framework.ts"),
    vitePlugins: [],
  }
}

/** Import an emitted edge worker/handler and call its fetch with a GET `/`. */
async function ssrThroughWorker(entry: string): Promise<{ status: number; html: string }> {
  const mod = (await import(entry)) as { default: unknown }
  const handler = mod.default as
    | ((req: Request) => Response | Promise<Response>)
    | { fetch(req: Request): Response | Promise<Response> }
  const fetchFn = typeof handler === "function" ? handler : handler.fetch.bind(handler)
  const res = await fetchFn(new Request("http://edge.test/"))
  return { status: res.status, html: await res.text() }
}

// @vitejs/plugin-react is a devDep of the examples, not of @nifrajs/web — resolve it from the example that
// ships it rather than adding a heavy build-only dep here. Skips (loudly) if it isn't installed, so a lean
// checkout doesn't red the suite on a plugin the framework itself doesn't depend on.
const EXAMPLE_WITH_REACT = join(import.meta.dir, "..", "..", "..", "examples", "cli-react")
const reactPluginPath = (() => {
  try {
    return Bun.resolveSync("@vitejs/plugin-react", EXAMPLE_WITH_REACT)
  } catch {
    return undefined
  }
})()

test.skipIf(reactPluginPath === undefined)(
  "cf-pages: the Vite edge worker SSRs React (edge react-dom/server + hook + CSS module)",
  async () => {
    const app = scaffoldReactApp()
    const react = ((await import(reactPluginPath as string)) as { default: () => unknown }).default
    const result = await buildTargetVite("cf-pages", {
      routesDir: app.routesDir,
      outDir: app.outDir,
      workDir: app.workDir,
      clientModule: "@nifrajs/web-react/client",
      adapterImport: app.frameworkFile,
      // biome-ignore lint/suspicious/noExplicitAny: Vite plugins ride the shared (Bun-typed) plugin slot
      clientPlugins: [react()] as any,
      // biome-ignore lint/suspicious/noExplicitAny: same
      serverPlugins: [react()] as any,
    })
    expect(result.target).toBe("cf-pages")

    const { status, html } = await ssrThroughWorker(join(app.outDir, "_worker.js"))
    expect(status).toBe(200)
    // The hook ran server-side: useState(41) rendered into the markup. React inserts a `<!-- -->` text
    // marker between the static text and the `{n}` expression, so match around it.
    expect(html).toMatch(/edge-react-(<!-- -->)?41/)
    // The document is nifra's shell with the hydration container + the hashed client entry.
    expect(html).toContain('id="root"')
    expect(html).toMatch(/<script type="module" src="\/assets\/[^"]+"><\/script>/)
    // The CSS-module class is SCOPED (hashed), not the raw `title` — the Vite CSS pipeline ran on the edge
    // build too, and SSR markup carries the same scoped class the client stylesheet defines.
    expect(html).toMatch(/class="_title_[\w]+"/i)
  },
  180_000,
)

// The self-contained-bundle claim, proven where it actually breaks. `buildTargetWith` copies ONE file out
// of the work dir as the deploy entry, so a server build that code-splits leaves its vendor chunk behind
// and the server dies at boot - never at build time. A vanilla fixture cannot show this (nothing to
// split); a REAL vendor dep can, and did: with `inlineDynamicImports` dropped, the `node` SSR target
// emitted `assets/react-<hash>.js` and booting `server.js` threw ERR_MODULE_NOT_FOUND on a path that was
// never written. bun/deno/edge did not split for the same input, which is precisely why only running the
// thing catches it.
test.skipIf(reactPluginPath === undefined)(
  "node: the Vite server bundle is self-contained and boots with React SSR",
  async () => {
    const app = scaffoldReactApp()
    const react = ((await import(reactPluginPath as string)) as { default: () => unknown }).default
    await buildTargetVite("node", {
      routesDir: app.routesDir,
      outDir: app.outDir,
      workDir: app.workDir,
      clientModule: "@nifrajs/web-react/client",
      adapterImport: app.frameworkFile,
      // biome-ignore lint/suspicious/noExplicitAny: Vite plugins ride the shared (Bun-typed) plugin slot
      clientPlugins: [react()] as any,
      // biome-ignore lint/suspicious/noExplicitAny: same
      serverPlugins: [react()] as any,
    })

    const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    const port = reservation.port
    reservation.stop(true)
    const proc = Bun.spawn([Bun.which("node") ?? "node", join(app.outDir, "server.js")], {
      env: { ...process.env, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      let html: string | undefined
      for (let i = 0; i < 60; i++) {
        await Bun.sleep(250)
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`)
          if (res.ok) {
            html = await res.text()
            break
          }
        } catch {
          // not up yet
        }
      }
      if (html === undefined) {
        proc.kill()
        await proc.exited
        throw new Error(
          `the built node server never came up:\n${await new Response(proc.stderr).text()}`,
        )
      }
      // The hook ran server-side through the single emitted file.
      expect(html).toMatch(/edge-react-(<!-- -->)?41/)
      expect(html).toContain('id="root"')
    } finally {
      proc.kill()
      await proc.exited
    }
  },
  180_000,
)
