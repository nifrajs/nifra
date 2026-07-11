import { describe, expect, test } from "bun:test"
import { assertRenderAdapterConformance, renderPageResult } from "@nifrajs/web"
import { html, type VanillaComponent, vanillaAdapter } from "../src/index.ts"

const Layout: VanillaComponent = ({ children }) =>
  html`<div data-layout="root"><nav>NAV</nav>${children}</div>`

const Page: VanillaComponent = (props) => html`<p>hi ${(props.data as { name: string }).name}</p>`

describe("vanillaAdapter through the RenderAdapter seam", () => {
  test("conforms to the executable RenderAdapter interface", async () => {
    const layout =
      (marker: string): VanillaComponent =>
      ({ children }) =>
        html`<section>${marker}${children}</section>`
    const ConformancePage: VanillaComponent = (props) =>
      html`<p>PAGE${(props.data as { name: string }).name}PENDING:${String(props.pending)}</p>`
    await assertRenderAdapterConformance(vanillaAdapter, {
      page: ConformancePage,
      outerLayout: layout("outer"),
      innerLayout: layout("inner"),
      props: { data: { name: "conformance-data" }, pending: true },
      markers: {
        page: "PAGE",
        data: "conformance-data",
        pending: "PENDING:true",
        outer: "outer",
        inner: "inner",
      },
    })
  })

  test("loader data is escaped end to end (hostile data can't break the page)", () => {
    const out = vanillaAdapter.renderToString?.([Page], {
      data: { name: "<img src=x onerror=alert(1)>" },
    })
    expect(out).toBe("<p>hi &lt;img src=x onerror=alert(1)&gt;</p>")
  })

  test("renderPageResult: full document, hydrate:false ships zero framework bootstrap", async () => {
    const page = renderPageResult({
      adapter: vanillaAdapter,
      chain: [Layout, Page],
      data: { name: "ada" },
      clientEntry: "/client.js",
      title: "Hotels",
      hydrate: false,
    } as never)
    const result = await Promise.resolve(page)
    const response = (result as { toResponse: () => Response }).toResponse()
    const doc = await response.text()
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(doc).toContain("<!doctype html>")
    expect(doc).toContain("<title>Hotels</title>")
    expect(doc).toContain("<p>hi ada</p>")
    // The zero-JS promise: no framework bootstrap, no client entry, no data global.
    expect(doc).not.toContain("/client.js")
    expect(doc).not.toContain("__NIFRA_DATA__")
    expect(doc).not.toContain('<script type="module"')
  })

  test("renderPageResult with islandScripts: island preload + module tag, still no framework", async () => {
    const page = renderPageResult({
      adapter: vanillaAdapter,
      chain: [Page],
      data: { name: "ada" },
      clientEntry: "/client.js",
      title: "Hotels",
      hydrate: false,
      islandScripts: ["/assets/compare-widget.js"],
    } as never)
    const result = await Promise.resolve(page)
    const doc = await (result as { toResponse: () => Response }).toResponse().text()
    expect(doc).toContain('<link rel="modulepreload" href="/assets/compare-widget.js">')
    expect(doc).toContain('<script type="module" src="/assets/compare-widget.js"></script>')
    expect(doc).not.toContain("__NIFRA_DATA__")
  })

  test("hydrationHead is empty (no client runtime)", () => {
    expect(vanillaAdapter.hydrationHead()).toBe("")
  })
})
