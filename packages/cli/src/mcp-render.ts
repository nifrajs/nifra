/**
 * The `nifra_render` engine + its child-process entry — the page half of `nifra_run`. Where `nifra_run`
 * runs requests through the BACKEND, this SSRs page routes through the WEB app (`createWebApp`), so an
 * agent can verify a page renders and its loader ran after an edit. Spawned fresh per call (`bun
 * mcp-render.ts <cwd>`) so the project's CURRENT route/loader code is loaded.
 *
 * No build required: a placeholder `clientEntry` is injected (the SSR HTML renders regardless — the
 * client bundle only matters for hydration in the browser, not for "did this page render server-side").
 * {@link renderPages} never throws — every failure (no config, a loader error, a render throw) becomes
 * `{ error }` so the agent gets the actionable message.
 */

import { inProcessClient } from "@nifrajs/client"
import { type AppLike, runApp } from "@nifrajs/runner"
import { createWebApp, type RenderAdapter } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import { loadApp, resolvePlugins } from "./load.ts"

const errString = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err)

/** Load the project, register its SSR plugins, and build the SSR `createWebApp` once — the cost the warm
 * worker amortizes across calls. Never throws (every failure → `{ error }`). Factored out of
 * {@link renderPages} so the cold path (fresh process per call) and the warm worker share one builder. */
async function buildWebApp(cwd: string): Promise<{ app: AppLike } | { error: string }> {
  let app: Awaited<ReturnType<typeof loadApp>>
  try {
    app = await loadApp(cwd, "dist")
  } catch (err) {
    return { error: errString(err) }
  }

  // Register the framework's SSR Bun plugins so `.vue`/`.svelte`/Solid route files compile on import
  // (React/Preact JSX is Bun-native → none). Mirrors `nifra start`.
  try {
    const { plugin } = await import("bun")
    for (const p of await resolvePlugins(app.framework.serverPlugins)) {
      plugin(p as Parameters<typeof plugin>[0])
    }
  } catch (err) {
    return { error: errString(err) }
  }

  try {
    const webApp = createWebApp({
      // The adapter is validated by loadApp; cast at the seam (same as the CLI's `asAdapter`).
      adapter: app.framework.adapter as RenderAdapter,
      manifest: discoverRoutes(app.routesDir),
      clientEntry: "/_nifra-render-only.js", // placeholder; SSR HTML does not need the built client
      ...(app.backend !== undefined ? { api: inProcessClient(app.backend as never) } : {}),
    }) as unknown as AppLike
    return { app: webApp }
  } catch (err) {
    return { error: errString(err) }
  }
}

export async function renderPages(
  cwd: string,
  requests: unknown,
): Promise<{ results: unknown } | { error: string }> {
  if (!Array.isArray(requests)) return { error: "expected { requests: [...] }" }

  const built = await buildWebApp(cwd)
  if ("error" in built) return built

  try {
    return { results: await runApp(built.app, requests as Parameters<typeof runApp>[1]) }
  } catch (err) {
    return { error: errString(err) }
  }
}

interface RenderWorkerMessage {
  readonly id?: unknown
  readonly input?: { readonly requests?: unknown }
}

/** Send console output to stderr so it never corrupts the newline-delimited JSON-RPC on stdout (mirrors
 * `mcp-run`'s worker). A loader that logs would otherwise inject noise into a response line. */
function redirectConsoleToStderr(): void {
  const write = (level: string, args: unknown[]): void => {
    Bun.stderr.write(`[${level}] ${args.map((arg) => String(arg)).join(" ")}\n`)
  }
  console.debug = (...args: unknown[]) => write("debug", args)
  console.info = (...args: unknown[]) => write("info", args)
  console.log = (...args: unknown[]) => write("log", args)
  console.warn = (...args: unknown[]) => write("warn", args)
  console.error = (...args: unknown[]) => write("error", args)
}

/**
 * Warm-worker loop (`--worker`): build the web app ONCE, then SSR each `{ id, input: { requests } }` line
 * against that hot app and reply `{ id, output }`. The parent (`mcp.ts`'s warm-render handler) spawns this,
 * fingerprints the source tree, and restarts the worker when a file changes — so warm reuse never serves a
 * stale render. Mirrors `mcp-run.ts`'s worker (single backend entry → no per-call entry key needed here).
 */
async function runWorker(cwd: string): Promise<void> {
  redirectConsoleToStderr()
  // Build once; the same `{ error }` is returned for every request if the build failed, so an agent sees
  // the actionable message and the parent restarts the worker on the next file change.
  const built = await buildWebApp(cwd)
  const decoder = new TextDecoder()
  let buffer = ""
  const send = (id: unknown, output: unknown): void => {
    process.stdout.write(`${JSON.stringify({ id, output })}\n`)
  }
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf("\n")
      if (line === "") continue

      let message: RenderWorkerMessage
      try {
        message = JSON.parse(line) as RenderWorkerMessage
      } catch {
        send(null, { error: "invalid worker input: expected JSON line" })
        continue
      }
      const requests = message.input?.requests
      if (!Array.isArray(requests)) {
        send(message.id, { error: "expected { requests: [...] }" })
        continue
      }
      if ("error" in built) {
        send(message.id, built)
        continue
      }
      try {
        send(message.id, {
          results: await runApp(built.app, requests as Parameters<typeof runApp>[1]),
        })
      } catch (err) {
        send(message.id, { error: errString(err) })
      }
    }
  }
}

// Child-process entry: read `{ requests }` from stdin, SSR, print JSON. `--worker` runs the persistent
// warm loop instead. Guarded so importing this module in a test does not execute it.
if (import.meta.main) {
  const cwd = process.argv[2] ?? process.cwd()
  // The parent (mcp.ts) spawns `bun mcp-render.ts <cwd>` WITHOUT setting the subprocess `cwd` option, so
  // this process inherits the MCP server's working dir, not the app's. SSR resolves `react-dom/server`
  // from `process.cwd()` to share ONE React core with the app's route components (the dual-React fix in
  // @nifrajs/web-react) — so we must chdir to the app root before any render. Best-effort: a bad path
  // surfaces later as a load error rather than crashing the child here.
  if (cwd !== process.cwd()) {
    try {
      process.chdir(cwd)
    } catch {
      // Leave cwd as-is; loadApp(cwd) below uses the explicit `cwd` arg and will report an actionable
      // error if the directory is unusable. The adapter then falls back to its bundled react-dom.
    }
  }
  if (process.argv.includes("--worker")) {
    await runWorker(cwd)
    process.exit(0)
  }
  let output: unknown
  try {
    const { requests } = JSON.parse(await Bun.stdin.text()) as { requests: unknown }
    output = await renderPages(cwd, requests)
  } catch {
    output = { error: "invalid input: expected JSON { requests: [...] }" }
  }
  process.stdout.write(JSON.stringify(output, null, 2))
}
