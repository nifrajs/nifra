import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineLocales } from "@nifrajs/i18n"
import { defineI18nRouting } from "@nifrajs/i18n/routing"
import { t } from "@nifrajs/schema"
import {
  buildManifest,
  createWebApp,
  notFound,
  type RenderAdapter,
  type RouteModule,
} from "../src/index.ts"
import { prerenderRoutes } from "../src/prerender.ts"
import { streamOf } from "./streams.ts"

const urls = defineI18nRouting(
  defineLocales({ default: "en", locales: { en: {}, fr: {}, de: {}, draft: { draft: true } } }),
  {
    pathnames: { "/about": { fr: "/a-propos", de: "/ueber-uns" } },
  },
)
const adapter: RenderAdapter = {
  hydrationHead: () => "",
  renderToStream: (_chain, props) => streamOf(`<main>${JSON.stringify(props.data)}</main>`),
}
const frontend: RouteModule = {
  default: () => null,
  meta: ({ params }) => {
    const { canonical, links } = urls.alternates(`/${params.path}`)
    return {
      link: [
        { rel: "canonical", href: canonical },
        ...links.map((link) => ({ rel: "alternate", ...link })),
      ],
    }
  },
}
const dispatcher: Omit<RouteModule, "default"> = {
  loaderOutput: t.object({ page: t.string(), locale: t.string() }),
  loader: ({ request }) => {
    const path = urls.unlocalizePathname(new URL(request.url).pathname).pathname
    if (path !== "/about") notFound()
    return { page: "about", locale: urls.localeOf(new URL(request.url).pathname) }
  },
}
const manifest = buildManifest(["[...path].tsx", "[...path].backend.ts"], (file) => async () => {
  if (file.endsWith(".backend.ts")) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: buildManifest imports both halves as RouteModule; this backend is merged with the frontend default before rendering.
    return dispatcher as RouteModule
  }
  return frontend
})
const app = createWebApp({ adapter, manifest, clientEntry: "/client.js", i18n: urls })

test("translated incoming URLs dispatch one canonical page with reciprocal SEO and data", async () => {
  const res = await app.fetch(new Request("https://example.com/fr/a-propos"))
  expect(res.status).toBe(200)
  expect(res.headers.get("content-language")).toBe("fr")
  const html = await res.text()
  expect(html).toContain('"page":"about","locale":"fr"')
  expect(html).toContain('href="/fr/a-propos"')
  expect(html).toContain('href="/de/ueber-uns"')
  const data = await app.fetch(
    new Request("https://example.com/de/ueber-uns", { headers: { "x-nifra-data": "1" } }),
  )
  expect(data.status).toBe(200)
  expect(await data.text()).toContain('"page":"about","locale":"de"')
  for (const path of ["/fr/unknown", "/draft/about", "/de/a-propos"]) {
    expect((await app.fetch(new Request(`https://example.com${path}`))).status).toBe(404)
  }
})

test("staticPathnames feeds real prerendered localized HTML and data outputs", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "nifra-pathnames-"))
  try {
    // Catch-all routes stay SSR-only; enumerate explicit static entries from the public URL list.
    const routes = urls.staticPathnames().map((path) => ({
      id: path,
      pattern: path,
      file: `${path}.tsx`,
      layoutIds: [],
      load: async () => ({ default: undefined, prerender: true }),
    }))
    const result = await prerenderRoutes({ app, routes, outDir })
    expect(result.prerendered).toHaveLength(3)
    for (const path of urls.staticPathnames()) {
      const html = readFileSync(join(outDir, path, "index.html"), "utf8")
      expect(html).toContain('"page":"about"')
      expect(html).toContain(`href="${path}"`)
      expect(readFileSync(join(outDir, path, "_data.json"), "utf8")).toContain('"page":"about"')
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
