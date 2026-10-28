import { expect, test } from "bun:test"
import type { StandardSchemaV1 } from "@nifrajs/core/server"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import { searchOfRequest } from "../src/internal/request-search.ts"
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
} as const

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
} as const

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

// A schema that counts its runs, so a test can see how often a request validates its search.
const counting = <S extends StandardSchemaV1>(base: S) => {
  const state = { runs: 0 }
  const schema = {
    "~standard": {
      ...base["~standard"],
      validate(input: unknown) {
        state.runs += 1
        return base["~standard"].validate(input)
      },
    },
  }
  return { state, schema }
}

test("a page's searchSchema runs once per document request, however many places read the search", async () => {
  const { state, schema } = counting(searchSchema)
  const seen: unknown[] = []
  const app = appWith(
    (ctx) => {
      seen.push(ctx.search)
      return null
    },
    schema,
    searchStub,
  )
  expect(await bodyOf(app, "/reports?page=3&q=hi")).toContain('<<{"page":3,"q":"hi"}>>')
  expect(state.runs).toBe(1)
  expect(seen).toEqual([{ page: 3, q: "hi" }])
})

test("each schema in a layout chain runs once per request", async () => {
  const page = counting(searchSchema)
  const layout = counting(layoutSchema)
  const app = createWebApp({
    adapter: searchStub,
    clientEntry: "/c.js",
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a hand-built manifest, as in the layout test above; only the fields these routes read are filled in.
    manifest: {
      routes: [
        {
          id: "reports",
          pattern: "/reports",
          layoutIds: ["app"],
          file: "reports.tsx",
          load: async () => ({ default: "reports", loader: () => null, searchSchema: page.schema }),
        },
      ],
      layouts: {
        app: {
          file: "_layout.tsx",
          load: async () => ({ default: "L", searchSchema: layout.schema }),
        },
      },
      notFound: { file: "_404.tsx", load: async () => ({ default: "404" }) },
    } as Manifest,
  })
  expect(await bodyOf(app, "/reports?org=acme&page=2")).toContain(
    '<<{"org":"acme","page":2,"q":""}>>',
  )
  expect([page.state.runs, layout.state.runs]).toEqual([1, 1])
})

test("a loader that edits its ctx.search leaves the render's search alone", async () => {
  const withSchema = appWith(
    (ctx) => {
      ctx.search.page = 99
      return null
    },
    searchSchema,
    searchStub,
  )
  expect(await bodyOf(withSchema, "/reports?page=3&q=hi")).toContain('<<{"page":3,"q":"hi"}>>')
  const withoutSchema = appWith(
    (ctx) => {
      ctx.search.page = 99
      return null
    },
    undefined,
    searchStub,
  )
  expect(await bodyOf(withoutSchema, "/reports?page=3")).toContain('<<{"page":3}>>')
})

test("searchOfRequest reads a request's query again when its text changed, and refuses a non-object output", () => {
  const request = new Request("http://x/reports")
  const { state, schema } = counting(searchSchema)
  expect(searchOfRequest(request, [schema], "?page=2")).toEqual({ page: 2, q: "" })
  expect(searchOfRequest(request, [schema], "?page=2")).toEqual({ page: 2, q: "" })
  expect(state.runs).toBe(1)
  expect(searchOfRequest(request, [undefined, schema], "?q=a")).toEqual({ page: 1, q: "a" })
  expect(state.runs).toBe(2)
  expect(searchOfRequest(request, [undefined], "?q=a")).toEqual({ q: "a" })
  expect(searchOfRequest(new Request("http://x/"), [undefined], "")).toEqual({})
  expect(searchOfRequest(new Request("http://x/"), [schema], "")).toEqual({ page: 1, q: "" })
  const array: StandardSchemaV1 = {
    "~standard": { version: 1, vendor: "test", validate: () => ({ value: [] }) },
  }
  expect(() => searchOfRequest(new Request("http://x/"), [array], "?q=a")).toThrow(
    "a search schema must produce an object",
  )
})
