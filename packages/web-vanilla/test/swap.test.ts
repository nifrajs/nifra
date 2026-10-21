import { describe, expect, test } from "bun:test"
import { createWebApp, type Manifest, redirect } from "@nifrajs/web"
import { MemoryCacheStore, withISR } from "../../web/src/isr.ts"
import { html, slot, type VanillaComponent, vanillaAdapter } from "../src/index.ts"

type Hotels = { readonly rows: readonly string[]; readonly saved?: unknown }

const Layout: VanillaComponent = ({ children }) =>
  html`<div><aside data-swap-slot="cart">${slot("cart", html`<b>2 items</b>`)}</aside>${children}</div>`

const Page: VanillaComponent = (props) => {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the hotels loader below returns a Hotels value
  const { rows } = props.data as Hotels
  return html`<section data-island="hotels">
    <form action="/hotels" method="get" data-swap="replace:results"><input name="q"></form>
    <ul data-swap-slot="results">${slot(
      "results",
      rows.map((row) => html`<li>${row}</li>`),
    )}</ul>
    <p>${props.actionData === undefined ? "" : JSON.stringify(props.actionData)}</p>
  </section>`
}

const manifest = (): Manifest => ({
  routes: [
    {
      id: "hotels",
      pattern: "/hotels",
      layoutIds: ["_layout"],
      file: "hotels.ts",
      load: async () => ({
        default: Page,
        hydrate: false,
        loader: (ctx) => {
          const q = new URL(ctx.request.url).searchParams.get("q") ?? ""
          if (q === "seen") ctx.set.cookie("seen", "1")
          return { rows: ["Ritz", "Savoy <&>"].filter((row) => row.includes(q)) }
        },
        action: async (ctx) => {
          const body = await ctx.request.formData()
          return body.get("go") === "1" ? redirect("/hotels?q=Ritz") : { saved: true }
        },
      }),
    },
  ],
  layouts: {
    _layout: { file: "_layout.ts", load: async () => ({ default: Layout }) },
  },
  notFound: { file: "_404.ts", load: async () => ({ default: () => html`<p>gone</p>` }) },
})

const app = () =>
  createWebApp({ adapter: vanillaAdapter, manifest: manifest(), clientEntry: "/c.js" })
const swap = (
  slotName: string,
  init: Omit<RequestInit, "headers"> & { readonly headers?: Record<string, string> } = {},
): RequestInit => ({ ...init, headers: { ...init.headers, "x-nifra-swap": slotName } })

describe("slot swap responses", () => {
  test("varying on swaps preserves ISR document hits while fragments bypass the cache", async () => {
    const handler = withISR(app(), { store: new MemoryCacheStore(), revalidate: 60, now: () => 0 })
    await handler(new Request("http://x/hotels"))
    const fragment = await handler(new Request("http://x/hotels", swap("results")))
    expect(fragment.headers.get("x-nifra-isr")).toBeNull()
    expect(await fragment.text()).toBe("<li>Ritz</li><li>Savoy &lt;&amp;&gt;</li>")
    const document = await handler(new Request("http://x/hotels"))
    expect(document.headers.get("x-nifra-isr")).toBe("hit")
    expect(await document.text()).toContain("<!doctype html>")
  })

  test("a swap request gets the slot's HTML alone, echoed and never storable", async () => {
    const res = await app().fetch(new Request("http://x/hotels?q=o", swap("results")))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("<li>Savoy &lt;&amp;&gt;</li>")
    expect(res.headers.get("x-nifra-swap")).toBe("results")
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("vary")).toContain("x-nifra-swap")
  })

  test("a slot a layout renders swaps too", async () => {
    const res = await app().fetch(new Request("http://x/hotels", swap("cart")))
    expect(await res.text()).toBe("<b>2 items</b>")
  })

  test("without the header, the document carries the same slot content", async () => {
    const res = await app().fetch(new Request("http://x/hotels?q=o"))
    const doc = await res.text()
    expect(doc).toContain("<!doctype html>")
    expect(doc).toContain('<ul data-swap-slot="results"><li>Savoy &lt;&amp;&gt;</li></ul>')
    expect(res.headers.get("x-nifra-swap")).toBeNull()
    expect(res.headers.get("vary")).toContain("x-nifra-swap")
  })

  test("a slot discarded by its layout cannot be fetched by naming it", async () => {
    const routes = manifest()
    const guarded = createWebApp({
      adapter: vanillaAdapter,
      manifest: {
        ...routes,
        layouts: {
          _layout: {
            file: "_layout.ts",
            load: async () => ({
              default: () => html`<h1>Access denied</h1>`,
            }),
          },
        },
      },
      clientEntry: "/c.js",
    })
    const response = await guarded.fetch(new Request("http://x/hotels", swap("results")))
    expect(response.headers.get("x-nifra-swap")).toBeNull()
    expect(await response.text()).not.toContain("Ritz")
  })

  test("an unknown or malformed slot name gets the whole document, unechoed", async () => {
    for (const name of ["nowhere", "a b", "<x>", "1st", "x".repeat(65)]) {
      const res = await app().fetch(new Request("http://x/hotels", swap(name)))
      expect(await res.text()).toContain("<!doctype html>")
      expect(res.headers.get("x-nifra-swap")).toBeNull()
    }
  })

  test("a cookie the loader sets reaches the swap response", async () => {
    const res = await app().fetch(new Request("http://x/hotels?q=seen", swap("results")))
    expect(res.headers.get("x-nifra-swap")).toBe("results")
    expect(res.headers.get("set-cookie")).toContain("seen=1")
  })

  test("a data request wins over the swap header", async () => {
    const res = await app().fetch(
      new Request("http://x/hotels", swap("results", { headers: { "x-nifra-data": "1" } })),
    )
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(res.headers.get("x-nifra-swap")).toBeNull()
  })

  test("a POST swap renders the slot with the action's data, or passes its redirect through", async () => {
    const post = (go: string) =>
      new Request(
        "http://x/hotels",
        swap("results", { method: "POST", body: new URLSearchParams({ go }) }),
      )
    const saved = await app().fetch(post("0"))
    expect(saved.headers.get("x-nifra-swap")).toBe("results")
    expect(await saved.text()).toBe("<li>Ritz</li><li>Savoy &lt;&amp;&gt;</li>")
    const moved = await app().fetch(post("1"))
    expect(moved.status).toBe(303)
    expect(moved.headers.get("location")).toBe("/hotels?q=Ritz")
  })

  test("a missing page answers with its document, so the client loads it normally", async () => {
    const res = await app().fetch(new Request("http://x/nope", swap("results")))
    expect(res.status).toBe(404)
    expect(res.headers.get("x-nifra-swap")).toBeNull()
  })
})

describe("slot()", () => {
  test("renders its content unchanged, escaping strings like any interpolation", () => {
    expect(slot("s", "<b>").html).toBe("&lt;b&gt;")
    const inner = html`<i>${"x"}</i>`
    expect(slot("s", inner).html).toBe(inner.html)
  })

  test("the adapter keeps the first slot of a name and nothing when it is absent", () => {
    const Twice: VanillaComponent = () => html`${slot("a", "one")}${slot("a", "two")}`
    expect(vanillaAdapter.renderSlot?.([Twice], { data: null }, "a")).toBe("one")
    expect(vanillaAdapter.renderSlot?.([Twice], { data: null }, "b")).toBeUndefined()
  })

  test("capture follows final output order, including prebuilt and nested templates", () => {
    const cached = slot("a", html`<b>cached</b>`)
    const Page: VanillaComponent = () => html`${cached}${slot("nested", slot("b", "child"))}`
    const Layout: VanillaComponent = ({ children }) => html`${slot("a", "layout first")}${children}`
    expect(vanillaAdapter.renderSlot?.([Layout, Page], { data: null }, "a")).toBe("layout first")
    expect(vanillaAdapter.renderSlot?.([Page], { data: null }, "a")).toBe("<b>cached</b>")
    expect(vanillaAdapter.renderSlot?.([Page], { data: null }, "b")).toBe("child")
    expect(vanillaAdapter.renderSlot?.([Page], { data: null }, "nested")).toBe("child")
  })

  test("constructing and discarding a slot does not expose it", () => {
    const Page: VanillaComponent = () => {
      slot("hidden", "private")
      return html`<p>public</p>`
    }
    expect(vanillaAdapter.renderSlot?.([Page], { data: null }, "hidden")).toBeUndefined()
  })
})
