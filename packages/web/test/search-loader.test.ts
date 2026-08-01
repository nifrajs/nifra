import { expect, test } from "bun:test"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import type { LoaderContext } from "../src/manifest.ts"

// Renders the loader data between markers so a test can read ctx.search back out of the HTML.
const stub: RenderAdapter = {
  renderToStream: (_chain, props) => {
    const bytes = new TextEncoder().encode(`[[${JSON.stringify(props.data)}]]`)
    return new ReadableStream({
      start(c) {
        c.enqueue(bytes)
        c.close()
      },
    })
  },
  hydrationHead: () => "",
}

// A hand-rolled Standard Schema: `page` coerced to a finite number (default 1), `q` kept as a string
// (default ""). Anything else falls back - the fail-closed behavior a real valibot/zod schema gives.
const searchSchema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate(input: unknown) {
      const raw = input as { page?: unknown; q?: unknown }
      const page = typeof raw.page === "number" && Number.isFinite(raw.page) ? raw.page : 1
      const q = typeof raw.q === "string" ? raw.q : ""
      return { value: { page, q } }
    },
  },
}

const appWith = (loader: (ctx: LoaderContext) => unknown, searchSchemaExport?: unknown) =>
  createWebApp({
    adapter: stub,
    clientEntry: "/c.js",
    manifest: {
      routes: [
        {
          id: "reports",
          pattern: "/reports",
          layoutIds: [],
          file: "reports.tsx",
          load: async () => ({ default: "reports", loader, searchSchema: searchSchemaExport }),
        },
      ],
      layouts: {},
      notFound: { file: "_404.tsx", load: async () => ({ default: "404" }) },
    } as Manifest,
  })

const bodyOf = (app: { fetch(r: Request): Response | Promise<Response> }, url: string) =>
  Promise.resolve(app.fetch(new Request(`http://x${url}`))).then((r) => r.text())

test("a route searchSchema gives the loader validated, typed ctx.search", async () => {
  const app = appWith((ctx) => ctx.search, searchSchema)
  expect(await bodyOf(app, "/reports?page=2&q=hi")).toContain('[[{"page":2,"q":"hi"}]]')
})

test("invalid search fails closed to the schema defaults, not a 500", async () => {
  const app = appWith((ctx) => ctx.search, searchSchema)
  const res = await app.fetch(new Request("http://x/reports?page=notanumber"))
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('[[{"page":1,"q":""}]]')
})

test("without a searchSchema, ctx.search is the raw parsed query", async () => {
  const app = appWith((ctx) => ctx.search)
  expect(await bodyOf(app, "/reports?page=2&q=hi&flag=true")).toContain(
    '[[{"page":2,"q":"hi","flag":true}]]',
  )
})
