/**
 * Render every page of the built site worker and report each one that does not answer as a page.
 *
 * A page can build cleanly and still throw on every request: Bun.build accepts a free identifier as
 * legal JavaScript, and `site/` is outside `bun run typecheck`. /docs/server-components shipped that
 * way - the JSX text `({ islands })` is an expression container, so rendering read an undefined
 * `islands` and the worker answered 500 `internal_error`. site/build.ts runs this on the assembled
 * `_worker.js` in a child process (the worker alone, as on Pages), so neither `check:site` nor a deploy
 * build passes with a page like that.
 *
 * The page set is the sitemap's (`routesUnder`), which `check:sitemap` holds equal to `site/routes`.
 * A path no route matches must reach the `_404` page, which the sitemap leaves out.
 */
import { resolve } from "node:path"
import { routesUnder } from "./gen-sitemap.ts"

/** The Pages advanced-mode worker shape: `fetch(request, env, ctx)`. */
export interface SiteWorker {
  fetch(
    request: Request,
    env: Record<string, never>,
    ctx: { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void },
  ): Response | Promise<Response>
}

const ORIGIN = "https://nifra.dev"
export const MISSING_PAGE = "/__nifra-check-missing-page"

/** Every page in `paths` that does not answer 200, plus `MISSING_PAGE` when it does not answer 404. */
export async function pageProblems(
  worker: SiteWorker,
  paths: readonly string[],
): Promise<string[]> {
  if (paths.length === 0) return ["no page to render - nothing was checked"]
  const background: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void background.push(promise),
    passThroughOnException: () => {},
  }
  const problems: string[] = []
  const expected = [...paths.map((path) => [path, 200] as const), [MISSING_PAGE, 404] as const]
  for (const [path, status] of expected) {
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`), {}, ctx)
    const body = await response.text()
    if (response.status !== status)
      problems.push(`${path}: expected ${status}, got ${response.status} ${body.slice(0, 200)}`)
  }
  await Promise.allSettled(background)
  return problems
}

/** Render every page route of the repository at `root` through the worker built into `workerPath`. */
export async function sitePageProblems(root: string, workerPath: string): Promise<string[]> {
  const worker: SiteWorker = (await import(workerPath)).default
  return pageProblems(
    worker,
    routesUnder(root).map((route) => route.url),
  )
}

if (import.meta.main) {
  const workerPath = process.argv[2]
  if (workerPath === undefined) {
    console.error("usage: bun scripts/site-pages.ts <path to the built _worker.js>")
    process.exit(2)
  }
  const root = resolve(import.meta.dir, "..")
  const problems = await sitePageProblems(root, resolve(workerPath))
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  console.log(`site pages: ${routesUnder(root).length} pages render, unknown paths reach _404`)
}
