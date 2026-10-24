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
 *
 * With `--out <dir>` each render is also written as a file Pages serves without the worker:
 * `<path>.html` (a `<path>/index.html` would make Pages redirect `/docs` to `/docs/`), the loader
 * data at the `<path>/_data.json` the client router fetches for a prerendered page, and the 404 page
 * as `404.html`, which Pages answers with a 404 for any path no file matches.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
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

/** The static file for a page path: `/` is `index.html`, `/docs/api` is `docs/api.html`. */
export const htmlFileOf = (path: string): string =>
  path === "/" ? "index.html" : `${path.slice(1)}.html`

/** The loader-data file the client router fetches for a prerendered path (`dataUrlFor` in
 * packages/web/src/router.ts): `/` is `_data.json`, `/docs/api` is `docs/api/_data.json`. */
export const dataFileOf = (path: string): string =>
  path === "/" ? "_data.json" : `${path.slice(1)}/_data.json`

/**
 * Every page in `paths` that does not answer 200, plus `MISSING_PAGE` when it does not answer 404.
 * Given `files`, each page's document and loader data are recorded there by file name, and a page
 * whose data does not answer as JSON is a problem too: a client navigation could not read it.
 */
export async function pageProblems(
  worker: SiteWorker,
  paths: readonly string[],
  files?: Map<string, string>,
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
    if (response.status !== status) {
      problems.push(`${path}: expected ${status}, got ${response.status} ${body.slice(0, 200)}`)
      continue
    }
    if (files === undefined) continue
    if (path === MISSING_PAGE) {
      files.set("404.html", body)
      continue
    }
    const data = await worker.fetch(
      new Request(`${ORIGIN}${path}`, { headers: { "x-nifra-data": "1" } }),
      {},
      ctx,
    )
    const json = await data.text()
    const type = data.headers.get("content-type") ?? ""
    if (data.status !== 200 || !type.startsWith("application/json")) {
      problems.push(`${path}: its data answered ${data.status} ${type}, not JSON`)
      continue
    }
    files.set(htmlFileOf(path), body)
    files.set(dataFileOf(path), json)
  }
  await Promise.allSettled(background)
  return problems
}

/** Render every page route of the repository at `root` through the worker built into `workerPath`,
 * recording each page's static files in `files` when given. */
export async function sitePageProblems(
  root: string,
  workerPath: string,
  files?: Map<string, string>,
): Promise<string[]> {
  const worker: SiteWorker = (await import(workerPath)).default
  return pageProblems(
    worker,
    routesUnder(root).map((route) => route.url),
    files,
  )
}

if (import.meta.main) {
  const workerPath = process.argv[2]
  const outFlag = process.argv.indexOf("--out")
  const outDir = outFlag === -1 ? undefined : process.argv[outFlag + 1]
  if (workerPath === undefined || (outFlag !== -1 && outDir === undefined)) {
    console.error("usage: bun scripts/site-pages.ts <path to the built _worker.js> [--out <dir>]")
    process.exit(2)
  }
  const root = resolve(import.meta.dir, "..")
  const files = outDir === undefined ? undefined : new Map<string, string>()
  const problems = await sitePageProblems(root, resolve(workerPath), files)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  if (outDir !== undefined) {
    for (const [file, text] of files ?? []) {
      const target = join(resolve(outDir), file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text)
    }
  }
  console.log(
    `site pages: ${routesUnder(root).length} pages render${files === undefined ? "" : " and are written"}, unknown paths reach _404`,
  )
}
