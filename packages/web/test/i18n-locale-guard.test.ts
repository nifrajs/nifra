import { describe, expect, test } from "bun:test"
import { defineLocales } from "../../i18n/src/locales.ts"
import { defineI18nRouting } from "../../i18n/src/routing.ts"
import {
  buildManifest,
  createWebApp,
  notFound,
  type RenderAdapter,
  type RouteMiddleware,
  type RouteModule,
  redirect,
} from "../src/index.ts"
import { DATA_HEADER, REDIRECT_HEADER } from "../src/router.ts"

// The documented locale guard: a `routes/[lang]/_middleware.ts` that checks the segment with
// `matchSegment`, so `/nonsense/about` and a draft locale answer 404 through the app's `_404`, and the
// default's prefix redirects - on a document request and on a client navigation alike.

const urls = defineI18nRouting(
  defineLocales({
    default: "en",
    locales: { en: {}, hi: {}, ur: { tag: "ur-PK" }, gu: { draft: true } },
  }),
)

const guard: RouteMiddleware = (ctx) => {
  const { pathname, search } = new URL(ctx.request.url)
  const match = urls.matchSegment(ctx.params.lang, pathname + search)
  if (match.kind === "not-found") notFound()
  if (match.kind === "redirect") return redirect(match.location, { status: 308 })
  return undefined
}

const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(`<main>${JSON.stringify({ chain, data: props.data })}</main>`),
        )
        c.close()
      },
    }),
  hydrationHead: () => "",
}

const modules: Record<string, Partial<RouteModule> & { default?: unknown }> = {
  "_404.tsx": {},
  "about.tsx": {},
  "[lang]/_middleware.ts": { default: guard },
  "[lang]/about.tsx": {
    loader: (ctx) => ({ lang: ctx.params.lang }),
    meta: ({ params }) => urls.locales.documentMeta(urls.localeOf(`/${params.lang}`)),
  },
}

const app = createWebApp({
  adapter: stub,
  clientEntry: "/c.js",
  manifest: buildManifest(
    Object.keys(modules),
    (file) => () => Promise.resolve({ default: file, ...modules[file] } as RouteModule),
  ),
})
const get = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://x${path}`, { headers }))

describe("a [lang] guard built on matchSegment", () => {
  test("a served locale renders, with <html lang> and <html dir> from the registry", async () => {
    const res = await get("/ur/about")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('"lang":"ur"')
    expect(html).toMatch(/<html[^>]*lang="ur-PK"/)
    expect(html).toMatch(/<html[^>]*dir="rtl"/)
  })

  test("an unknown value and a draft locale answer 404 through the app's _404", async () => {
    for (const path of ["/nonsense/about", "/gu/about"]) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(await res.text()).toContain("_404.tsx")
    }
  })

  test("the default's prefix and a wrong case redirect permanently to the canonical URL", async () => {
    const en = await get("/en/about?ref=1")
    expect(en.status).toBe(308)
    expect(en.headers.get("location")).toBe("/about?ref=1")
    const upper = await get("/HI/about")
    expect(upper.status).toBe(308)
    expect(upper.headers.get("location")).toBe("/hi/about")
  })

  test("a client navigation gets the same answers", async () => {
    const missing = await get("/nonsense/about", { [DATA_HEADER]: "1" })
    expect(missing.status).toBe(404)
    const moved = await get("/en/about", { [DATA_HEADER]: "1" })
    expect(moved.headers.get(REDIRECT_HEADER)).toBe("/about")
  })

  test("the unprefixed default page is untouched", async () => {
    expect((await get("/about")).status).toBe(200)
  })
})
