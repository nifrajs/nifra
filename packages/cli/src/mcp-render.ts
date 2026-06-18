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

export async function renderPages(
  cwd: string,
  requests: unknown,
): Promise<{ results: unknown } | { error: string }> {
  if (!Array.isArray(requests)) return { error: "expected { requests: [...] }" }

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

  let webApp: AppLike
  try {
    webApp = createWebApp({
      // The adapter is validated by loadApp; cast at the seam (same as the CLI's `asAdapter`).
      adapter: app.framework.adapter as RenderAdapter,
      manifest: discoverRoutes(app.routesDir),
      clientEntry: "/_nifra-render-only.js", // placeholder; SSR HTML does not need the built client
      ...(app.backend !== undefined ? { api: inProcessClient(app.backend as never) } : {}),
    }) as unknown as AppLike
  } catch (err) {
    return { error: errString(err) }
  }

  try {
    return { results: await runApp(webApp, requests as Parameters<typeof runApp>[1]) }
  } catch (err) {
    return { error: errString(err) }
  }
}

// Child-process entry: read `{ requests }` from stdin, SSR, print JSON. Guarded so importing this
// module in a test does not execute it.
if (import.meta.main) {
  const cwd = process.argv[2] ?? process.cwd()
  let output: unknown
  try {
    const { requests } = JSON.parse(await Bun.stdin.text()) as { requests: unknown }
    output = await renderPages(cwd, requests)
  } catch {
    output = { error: "invalid input: expected JSON { requests: [...] }" }
  }
  process.stdout.write(JSON.stringify(output, null, 2))
}
