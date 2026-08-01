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

// A stub that renders RenderProps.search between markers, so a test can assert the SERVER threads the
// validated search into the adapter's render input (RenderProps), not just into the loader's ctx.
const searchStub: RenderAdapter = {
  renderToStream: (_chain, props) => {
    const bytes = new TextEncoder().encode(`<<${JSON.stringify(props.search ?? null)}>>`)
    return new ReadableStream({
      start(c) {
        c.enqueue(bytes)
        c.close()
      },
    })
  },
  hydrationHead: () => "",
}

const appWith = (
  loader: (ctx: LoaderContext) => unknown,
  searchSchemaExport?: unknown,
  adapter: RenderAdapter = stub,
) =>
  createWebApp({
    adapter,
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

test("the render's RenderProps.search is the same validated value as the loader's ctx.search", async () => {
  // Proves the server wiring end to end: the page render threads `search` into the adapter's props, so
  // an adapter's `useSearch` is SSR-correct. The client mount recomputes the identical value via the
  // shared `searchOf`, which is what makes hydration match.
  const app = appWith(() => null, searchSchema, searchStub)
  expect(await bodyOf(app, "/reports?page=3&q=hi")).toContain('<<{"page":3,"q":"hi"}>>')
})

test("RenderProps.search fails closed to the schema defaults on hostile input", async () => {
  const app = appWith(() => null, searchSchema, searchStub)
  expect(await bodyOf(app, "/reports?page=notanumber")).toContain('<<{"page":1,"q":""}>>')
})

// A layout that owns a shared key (`org`); the route's effective search merges it with the page's keys.
const layoutSchema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate(input: unknown) {
      const raw = input as { org?: unknown }
      return { value: { org: typeof raw.org === "string" ? raw.org : "none" } }
    },
  },
}

test("a layout's searchSchema merges with the page's (page-wins) in ctx.search", async () => {
  const app = createWebApp({
    adapter: stub,
    clientEntry: "/c.js",
    manifest: {
      routes: [
        {
          id: "reports",
          pattern: "/reports",
          layoutIds: ["app"],
          file: "reports.tsx",
          load: async () => ({
            default: "reports",
            loader: (ctx: LoaderContext) => ctx.search,
            searchSchema,
          }),
        },
      ],
      layouts: {
        app: {
          file: "_layout.tsx",
          load: async () => ({ default: "L", searchSchema: layoutSchema }),
        },
      },
      notFound: { file: "_404.tsx", load: async () => ({ default: "404" }) },
    } as Manifest,
  })
  // `org` (layout) + `page`/`q` (page), each validated, merged into one object the loader receives.
  expect(await bodyOf(app, "/reports?org=acme&page=2&q=hi")).toContain(
    '[[{"org":"acme","page":2,"q":"hi"}]]',
  )
})
