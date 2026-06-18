import { describe, expect, test } from "bun:test"
import { renderPageResult } from "@nifrajs/web"
import { compose, html, type VanillaComponent, vanillaAdapter } from "../src/index.ts"

const toText = (s: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>) =>
  Promise.resolve(s).then((stream) => new Response(stream).text())

const Layout: VanillaComponent = ({ children }) =>
  html`<div data-layout="root"><nav>NAV</nav>${children}</div>`

const Page: VanillaComponent = (props) => html`<p>hi ${(props.data as { name: string }).name}</p>`

describe("vanillaAdapter through the RenderAdapter seam", () => {
  test("renderToString folds a layout chain, data reaches the page", () => {
    const out = vanillaAdapter.renderToString?.([Layout, Page], { data: { name: "ada" } })
    expect(out).toBe('<div data-layout="root"><nav>NAV</nav><p>hi ada</p></div>')
  })

  test("renderToStream emits the same markup as renderToString", async () => {
    const streamed = await toText(
      vanillaAdapter.renderToStream([Layout, Page], { data: { name: "ada" } }),
    )
    const buffered = vanillaAdapter.renderToString?.([Layout, Page], { data: { name: "ada" } })
    expect(streamed).toBe(buffered as string)
  })

  test("three-deep chain wraps outermost-first", () => {
    const Outer: VanillaComponent = ({ children }) => html`<o>${children}</o>`
    const Inner: VanillaComponent = ({ children }) => html`<i>${children}</i>`
    const Leaf: VanillaComponent = () => html`<x/>`
    expect(compose([Outer, Inner, Leaf], { data: null }).html).toBe("<o><i><x/></i></o>")
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
