import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MISSING_PAGE, pageProblems, type SiteWorker, sitePageProblems } from "./site-pages.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workerFor(statuses: Readonly<Record<string, number>>): SiteWorker {
  return {
    fetch(request) {
      const status = statuses[new URL(request.url).pathname] ?? 404
      return new Response(
        status === 500 ? '{"ok":false,"error":"internal_error"}' : "<p>page</p>",
        {
          status,
        },
      )
    },
  }
}

test("control: every page answering 200 and an unknown path answering 404 pass", async () => {
  expect(await pageProblems(workerFor({ "/": 200, "/docs": 200 }), ["/", "/docs"])).toEqual([])
})

test("a page that fails to render and a missing page that renders are both reported", async () => {
  const worker = workerFor({ "/": 200, "/docs/broken": 500, [MISSING_PAGE]: 200 })
  expect(await pageProblems(worker, ["/", "/docs/broken"])).toEqual([
    '/docs/broken: expected 200, got 500 {"ok":false,"error":"internal_error"}',
    `${MISSING_PAGE}: expected 404, got 200 <p>page</p>`,
  ])
})

test("no page fails instead of passing an empty check", async () => {
  expect(await pageProblems(workerFor({}), [])).toEqual(["no page to render - nothing was checked"])
})

test("background work a render hands to waitUntil settles before the result", async () => {
  let settled = false
  const worker: SiteWorker = {
    fetch(_request, _env, ctx) {
      ctx.waitUntil(Promise.reject(new Error("background")).finally(() => (settled = true)))
      return new Response("<p>page</p>", { status: 404 })
    },
  }
  expect(await pageProblems(worker, ["/"])).toEqual(["/: expected 200, got 404 <p>page</p>"])
  expect(settled).toBe(true)
})

test("the site check renders each page route of the tree through the built worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "site-pages-"))
  roots.push(root)
  mkdirSync(join(root, "site", "routes", "docs"), { recursive: true })
  for (const page of ["index.tsx", "_layout.tsx", "_404.tsx", "docs/guide.tsx"])
    writeFileSync(join(root, "site", "routes", page), "export default 1\n")
  const worker = join(root, "_worker.js")
  writeFileSync(
    worker,
    `const statuses = { "/": 200, "/docs/guide": 500 }
export default { fetch(request) {
  const path = new URL(request.url).pathname
  return new Response(path, { status: statuses[path] ?? 404 })
} }\n`,
  )
  expect(await sitePageProblems(root, worker)).toEqual([
    "/docs/guide: expected 200, got 500 /docs/guide",
  ])
})

test("given a file map, each page's document and loader data are recorded where Pages serves them", async () => {
  const worker: SiteWorker = {
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === MISSING_PAGE) return new Response("<p>404</p>", { status: 404 })
      if (request.headers.get("x-nifra-data") === null) return new Response(`<p>${path}</p>`)
      if (path === "/docs/stream")
        return new Response("{}\n", { headers: { "content-type": "application/x-ndjson" } })
      if (path === "/docs/torn")
        return new Response('{"path":', { headers: { "content-type": "application/json" } })
      return Response.json({ path })
    },
  }
  const files = new Map<string, string>()
  expect(
    await pageProblems(worker, ["/", "/docs", "/docs/api", "/docs/stream", "/docs/torn"], files),
  ).toEqual([
    "/docs/stream: its data answered 200 application/x-ndjson, not JSON",
    '/docs/torn: its data is not valid JSON: {"path":',
  ])
  expect(Object.fromEntries(files)).toEqual({
    "index.html": "<p>/</p>",
    "_data.json": '{"path":"/"}',
    "docs.html": "<p>/docs</p>",
    "docs/_data.json": '{"path":"/docs"}',
    "docs/api.html": "<p>/docs/api</p>",
    "docs/api/_data.json": '{"path":"/docs/api"}',
    "404.html": "<p>404</p>",
  })
})
