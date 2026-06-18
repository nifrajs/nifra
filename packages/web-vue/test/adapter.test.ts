import { expect, test } from "bun:test"
import { defineComponent, h, type VNode } from "vue"
import { compose } from "../src/compose.ts"
import { vueAdapter } from "../src/index.ts"

// SSR side runs under bun (vue/server-renderer). Full hydration is browser-verified against the
// real packages (see examples/web-vue) — bun:test has no DOM. Unlike React, Vue SSR resolves
// async deps before flushing (no fallback-then-content boundary semantics), so there is no
// streaming-order test here — Vue's `renderToWebStream` chunks the serialized buffer, it does
// not progressively render Suspense fallbacks the way React's `renderToReadableStream` does.

// Drain the adapter's Web ReadableStream to a string.
const toText = (s: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>) =>
  Promise.resolve(s).then((stream) => new Response(stream).text())

// A layout component that renders its child through the default slot (the `compose` contract).
const makeLayout = (marker: string) =>
  defineComponent({
    setup:
      (_props, { slots }) =>
      () =>
        h("div", { "data-layout": marker }, [`NAV:${marker}`, slots.default?.()]),
  })

// A page component that reads loader data + an extra prop off `props` (what `compose` spreads in).
const Page = defineComponent({
  props: { data: { type: Object, required: true }, pending: { type: Boolean, default: false } },
  setup: (props: { data: { name: string }; pending: boolean }) => () =>
    h("p", { "data-pending": String(props.pending) }, `hi ${props.data.name}`),
})

test("renderToStream renders a single-element chain (page only)", async () => {
  const Comp = defineComponent({ setup: () => () => h("h1", null, "hello world") })
  const html = await toText(vueAdapter.renderToStream([Comp], { data: null }))
  expect(html).toContain("hello world")
  expect(html).toContain("<h1")
})

test("renderToStream folds a layout chain: layout wraps page, data + props reach the page", async () => {
  const html = await toText(
    vueAdapter.renderToStream([makeLayout("outer"), Page], {
      data: { name: "ada" },
      pending: true,
    }),
  )
  expect(html).toContain('data-layout="outer"') // the layout rendered
  expect(html).toContain("NAV:outer") // the layout's own content
  expect(html).toContain("hi ada") // the page, with loader data, nested inside the layout
  expect(html).toContain('data-pending="true"') // a non-`data` prop was spread onto the page too
})

test("renderToString folds the same layout chain for the non-deferred fast path", async () => {
  const renderToString = vueAdapter.renderToString
  if (renderToString === undefined) throw new Error("vueAdapter.renderToString is missing")
  const html = await renderToString([makeLayout("sync"), Page], {
    data: { name: "ada" },
    pending: true,
  })
  expect(html).toContain('data-layout="sync"')
  expect(html).toContain("hi ada")
  expect(html).toContain('data-pending="true"')
})

test("renderToStream folds a multi-layer chain (outer → inner → page), nesting in order", async () => {
  const html = await toText(
    vueAdapter.renderToStream([makeLayout("outer"), makeLayout("inner"), Page], {
      data: { name: "grace" },
    }),
  )
  // Outer must wrap inner must wrap the page — assert the source order of the nested markers.
  const outerAt = html.indexOf('data-layout="outer"')
  const innerAt = html.indexOf('data-layout="inner"')
  const pageAt = html.indexOf("hi grace")
  expect(outerAt).toBeGreaterThanOrEqual(0)
  expect(innerAt).toBeGreaterThan(outerAt) // inner is nested inside outer
  expect(pageAt).toBeGreaterThan(innerAt) // page is nested inside inner
})

test("compose returns a single VNode for a single-element chain (loop body never runs)", () => {
  const node = compose([Page], { data: { name: "x" } }) as VNode
  // The page component is the root VNode; no wrapping layout was added.
  expect(node.type).toBe(Page)
  expect((node.props as { data: { name: string } }).data.name).toBe("x")
})

test("compose nests layouts as default-slot children (the fold direction)", () => {
  const Outer = makeLayout("outer")
  const node = compose([Outer, Page], { data: { name: "y" } }) as VNode
  // Root is the outer layout; the page is its default-slot child.
  expect(node.type).toBe(Outer)
  const slots = node.children as { default: () => VNode }
  const child = slots.default()
  expect(child.type).toBe(Page)
})

test("hydrationHead is empty (Vue reconciles the DOM on createSSRApp; no bootstrap script)", () => {
  expect(vueAdapter.hydrationHead()).toBe("")
})
