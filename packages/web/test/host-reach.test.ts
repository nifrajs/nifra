import { expect, test } from "bun:test"
import { checkHostReach } from "../src/host-reach.ts"

test("a page limit reports unchecked declared pages even without pending assets", async () => {
  const fetched: string[] = []
  const report = await checkHostReach({
    host: "app.test",
    pages: ["/ok", "/broken"],
    limit: 1,
    fetch: async (path) => {
      fetched.push(path)
      return new Response("<p>page</p>", { status: path === "/broken" ? 404 : 200 })
    },
  })

  expect(fetched).toEqual(["/ok"])
  expect(report.failures).toEqual([])
  expect(report.truncated).toBe(true)
  expect(report.ok).toBe(false)
})

test("the default limit cannot pass after checking only the first 500 pages", async () => {
  const fetched: string[] = []
  const report = await checkHostReach({
    host: "app.test",
    pages: Array.from({ length: 501 }, (_, index) => `/page-${index}`),
    fetch: async (path) => {
      fetched.push(path)
      return new Response("<p>page</p>", { status: path === "/page-500" ? 404 : 200 })
    },
  })

  expect(fetched).toHaveLength(500)
  expect(fetched).not.toContain("/page-500")
  expect(report.truncated).toBe(true)
  expect(report.ok).toBe(false)
})

test("repeated declared pages are checked separately and can exactly fill the limit", async () => {
  const fetched: string[] = []
  const report = await checkHostReach({
    host: "app.test",
    pages: ["/", "/"],
    limit: 2,
    fetch: async (path) => {
      fetched.push(path)
      return new Response("<p>page</p>")
    },
  })

  expect(fetched).toEqual(["/", "/"])
  expect(report.results.map((result) => result.kind)).toEqual(["page", "page"])
  expect(report.truncated).toBe(false)
  expect(report.ok).toBe(true)
})

test("pending asset dependencies still report truncation at the file limit", async () => {
  const fetched: string[] = []
  const report = await checkHostReach({
    host: "app.test",
    pages: ["/"],
    limit: 2,
    fetch: async (path) => {
      fetched.push(path)
      return path === "/"
        ? new Response('<script src="/entry.js"></script>')
        : new Response('import "./chunk.js"', {
            headers: { "content-type": "text/javascript" },
          })
    },
  })

  expect(fetched).toEqual(["/", "/entry.js"])
  expect(report.truncated).toBe(true)
  expect(report.ok).toBe(false)
})

test.each([0, 1])("binary bodies stay unread (queue %i)", async (highWaterMark) => {
  let pulls = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls === 4) {
          controller.close()
          return
        }
        pulls++
        controller.enqueue(new Uint8Array(16))
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark },
  )
  // The default queue can pull once on construction, before the checker receives the stream.
  await Promise.resolve()
  const initialPulls = pulls
  const report = await checkHostReach({
    host: "app.test",
    pages: ["/"],
    fetch: async (path) =>
      path === "/"
        ? new Response('<img src="/large.png">')
        : new Response(stream, { headers: { "content-type": "image/png" } }),
  })

  expect(report.results).toContainEqual({
    path: "/large.png",
    kind: "asset",
    status: 200,
    from: "/",
  })
  expect(pulls).toBe(initialPulls)
  expect(cancelled).toBe(true)
  expect(report.ok).toBe(true)
})

test("CSS URLs and static and dynamic script imports are still followed once", async () => {
  const fetched: string[] = []
  const files: Record<string, { readonly body: string; readonly type: string }> = {
    "/": {
      body: '<link rel="stylesheet" href="/assets/app.css"><script src="/assets/entry.js"></script>',
      type: "text/html",
    },
    "/assets/app.css": {
      body: '@import url("./theme.css"); .hero { background: url("./photo.png") }',
      type: "text/css",
    },
    "/assets/theme.css": { body: "body { color: teal }", type: "text/css" },
    "/assets/photo.png": { body: "binary", type: "image/png" },
    "/assets/entry.js": {
      body: 'import "./chunk.js"; import("./lazy.js")',
      type: "application/javascript",
    },
    "/assets/chunk.js": { body: 'import "./entry.js"', type: "text/javascript" },
    "/assets/lazy.js": { body: "export const value = 1", type: "text/javascript" },
  }
  const report = await checkHostReach({
    host: "app.test",
    pages: ["/"],
    fetch: async (path) => {
      fetched.push(path)
      const file = files[path]
      return file === undefined
        ? new Response(null, { status: 404 })
        : new Response(file.body, { headers: { "content-type": file.type } })
    },
  })

  expect(fetched.toSorted()).toEqual(Object.keys(files).toSorted())
  expect(report.failures).toEqual([])
  expect(report.truncated).toBe(false)
  expect(report.ok).toBe(true)
})
