import { expect, test } from "bun:test"
import {
  createWebApp,
  type Manifest,
  type MetaArgs,
  type RenderAdapter,
  type RouteModule,
  resolveChainMeta,
} from "../src/index.ts"
import { DATA_HEADER } from "../src/router.ts"

const streamOf = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })

const stub: RenderAdapter = {
  renderToStream: () => streamOf("<p>page</p>"),
  hydrationHead: () => "",
}

const args = (data: unknown): MetaArgs => ({ data, pageData: data, params: {}, origin: "" })

/** A string field of loader data, read without asserting the data's type. */
const field = (data: unknown, key: string): string => String(Reflect.get(Object(data), key))

test("a layout's function meta reads its own loader data; the page's reads the page's", () => {
  const seen: MetaArgs[] = []
  const heads = resolveChainMeta(
    [
      (a: MetaArgs) => {
        seen.push(a)
        return { lang: field(a.data, "locale") }
      },
      undefined,
      (a: MetaArgs) => {
        seen.push(a)
        return { title: `${field(a.pageData, "title")} | Site` }
      },
      (a: MetaArgs) => {
        seen.push(a)
        return { title: field(a.data, "title") }
      },
    ],
    [{ locale: "hi" }, null, undefined],
    args({ title: "Articles" }),
  )
  expect(heads).toEqual([{ lang: "hi" }, {}, { title: "Articles | Site" }, { title: "Articles" }])
  expect(seen).toEqual([
    { data: { locale: "hi" }, pageData: { title: "Articles" }, params: {}, origin: "" },
    // A layout with no loader gets null, the value its component renders.
    { data: null, pageData: { title: "Articles" }, params: {}, origin: "" },
    { data: { title: "Articles" }, pageData: { title: "Articles" }, params: {}, origin: "" },
  ])
})

test("a static layout meta and a chain with no layout data resolve as before", () => {
  const layoutMeta = { title: "Site" }
  const heads = resolveChainMeta(
    [layoutMeta, (a: MetaArgs) => ({ lang: String(a.data) })],
    undefined,
    args("en"),
  )
  expect(heads[0]).toBe(layoutMeta)
  expect(heads[1]).toEqual({ lang: "en" })
})

const page: RouteModule = {
  default: "page",
  loader: () => ({ title: "Article of the day" }),
  meta: ({ data }: MetaArgs) => ({ title: field(data, "title") }),
}
const layout: RouteModule = {
  default: "layout",
  loader: ({ params }) => ({ locale: params.lang }),
  meta: ({ data, pageData }: MetaArgs) => ({
    lang: field(data, "locale"),
    meta: [{ name: "x-page-title", content: field(pageData, "title") }],
  }),
}
const manifest: Manifest = {
  routes: [
    {
      id: "[lang]/articles",
      pattern: "/:lang/articles",
      layoutIds: ["[lang]/_layout"],
      layoutParams: [["lang"]],
      file: "[lang]/articles.tsx",
      load: async () => page,
    },
  ],
  layouts: { "[lang]/_layout": { file: "[lang]/_layout.tsx", load: async () => layout } },
}
const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })

test("SSR: a layout's meta sets <html lang> from its own loader data", async () => {
  const html = await (await app.fetch(new Request("http://x/hi/articles"))).text()
  expect(html).toContain('<html lang="hi"')
  expect(html).toContain("<title>Article of the day</title>")
  expect(html).toContain('content="Article of the day"')
})

test("the navigation payload carries the layout data the client's head resolves from", async () => {
  const res = await app.fetch(
    new Request("http://x/hi/articles", { headers: { [DATA_HEADER]: "1" } }),
  )
  const payload: unknown = await res.json()
  const layoutData: unknown = Reflect.get(Object(payload), "layoutData")
  expect(layoutData).toEqual([{ locale: "hi" }])
  const head = resolveChainMeta(
    [
      ({ data }: MetaArgs) => ({ lang: field(data, "locale") }),
      ({ data }: MetaArgs) => ({ title: field(data, "title") }),
    ],
    Array.isArray(layoutData) ? layoutData : undefined,
    args(Reflect.get(Object(payload), "data")),
  )
  expect(head).toEqual([{ lang: "hi" }, { title: "Article of the day" }])
})
