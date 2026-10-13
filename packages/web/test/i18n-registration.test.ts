import { describe, expect, test } from "bun:test"
import { defineLocales } from "../../i18n/src/locales.ts"
import { defineI18nRouting } from "../../i18n/src/routing.ts"
import {
  buildManifest,
  createWebApp,
  LOCALES_GLOBAL,
  type RenderAdapter,
  type RouteModule,
} from "../src/index.ts"
import { DATA_HEADER, REDIRECT_HEADER } from "../src/router.ts"

// An app that registers its locale routing once (`createWebApp({ i18n })`) and writes no layout or
// middleware code for it.

const urls = defineI18nRouting(
  defineLocales({
    default: "en",
    locales: { en: {}, hi: {}, ur: { tag: "ur-PK" }, gu: { draft: true } },
  }),
  { pageLocales: (pathname) => (pathname.startsWith("/repairs/") ? ["en", "hi"] : undefined) },
)

// Renders the locale the adapter is handed, so a test sees `RenderProps.locale`.
const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `<main>${JSON.stringify({ chain, locale: props.locale ?? null })}</main>`,
          ),
        )
        c.close()
      },
    }),
  hydrationHead: () => "",
}

const modules: Record<string, Partial<RouteModule> & { default?: unknown }> = {
  "_404.tsx": {},
  "about.tsx": {},
  "[[lang]]/x.tsx": {},
  "[[lang]]/shop.tsx": { meta: { lang: "fr" } },
  "[lang]/repairs/brakes.tsx": {},
  "(site)/[lang]/fleet.tsx": {},
}

const appWith = (i18n: Parameters<typeof createWebApp>[0]["i18n"]) => {
  const options = {
    adapter: stub,
    clientEntry: "/c.js",
    manifest: buildManifest(
      Object.keys(modules),
      (file) => () =>
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the module table above holds only RouteModule fields, keyed by the files it lists.
        Promise.resolve({ default: file, ...modules[file] } as RouteModule),
    ),
  }
  return createWebApp(i18n === undefined ? options : { ...options, i18n })
}
const app = appWith(urls)
const get = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://x${path}`, { headers }))

const htmlTag = (html: string) => html.match(/<html[^>]*>/)?.[0]

describe("createWebApp({ i18n })", () => {
  test("with no layout code, /ur/x renders <html lang dir> and Content-Language from the registry", async () => {
    const res = await get("/ur/x")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-language")).toBe("ur-PK")
    const html = await res.text()
    expect(htmlTag(html)).toBe('<html lang="ur-PK" dir="rtl">')
    expect(html).toContain('"locale":{"key":"ur","lang":"ur-PK","dir":"rtl"}')
    expect(html).toContain(
      `"${LOCALES_GLOBAL}":{"default":"en","locales":[{"key":"en","lang":"en","dir":"ltr"},{"key":"hi","lang":"hi","dir":"ltr"},{"key":"ur","lang":"ur-PK","dir":"rtl"}]}`,
    )
  })

  test("every document takes its locale: unprefixed, outside [lang], and each locale of one cached route", async () => {
    const about = await get("/about")
    expect(about.headers.get("content-language")).toBe("en")
    expect(htmlTag(await about.text())).toBe('<html lang="en" dir="ltr">')
    for (const [path, tag] of [
      ["/hi/x", '<html lang="hi" dir="ltr">'],
      ["/ur/x", '<html lang="ur-PK" dir="rtl">'],
      ["/x", '<html lang="en" dir="ltr">'],
      ["/hi/x", '<html lang="hi" dir="ltr">'],
    ] as const) {
      expect(htmlTag(await (await get(path)).text())).toBe(tag)
    }
  })

  test("a route's meta lang wins, with its own dir", async () => {
    const res = await get("/ur/shop")
    expect(res.headers.get("content-language")).toBe("fr")
    expect(htmlTag(await res.text())).toBe('<html lang="fr">')
  })

  test("/en/x redirects to /x, since the default is unprefixed, on a load and a navigation", async () => {
    const res = await get("/en/x?ref=1")
    expect(res.status).toBe(308)
    expect(res.headers.get("location")).toBe("/x?ref=1")
    const nav = await get("/en/x", { [DATA_HEADER]: "1" })
    expect(nav.headers.get(REDIRECT_HEADER)).toBe("/x")
    expect((await get("/HI/fleet")).headers.get("location")).toBe("/hi/fleet")
  })

  test("an unserved locale, a draft, and a page missing from the locale are 404s", async () => {
    for (const path of ["/nonsense/x", "/gu/x", "/ur/repairs/brakes", "/nonsense/fleet"]) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(res.headers.get("content-language")).not.toBeNull()
      expect(await res.text()).toContain("_404.tsx")
    }
    expect((await get("/hi/repairs/brakes")).status).toBe(200)
    expect((await get("/nonsense/x", { [DATA_HEADER]: "1" })).status).toBe(404)
  })

  test("without i18n the document is as before", async () => {
    const res = await appWith(undefined).fetch(new Request("http://x/ur/x"))
    expect(res.headers.get("content-language")).toBeNull()
    const html = await res.text()
    expect(htmlTag(html)).toBe('<html lang="en">')
    expect(html).not.toContain(LOCALES_GLOBAL)
    expect(html).toContain('"locale":null')
  })

  test("an i18n that is not a locale router is refused at creation", () => {
    // What untyped code can hand over: no localeOf, no matchSegment.
    expect(() => appWith(JSON.parse('{"locales":{"served":[]}}'))).toThrow(
      "createWebApp `i18n` must be the router defineI18nRouting() from @nifrajs/i18n/routing returns",
    )
  })
})
