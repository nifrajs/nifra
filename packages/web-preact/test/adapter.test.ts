import { expect, test } from "bun:test"
import type { RenderProps } from "@nifrajs/web"
import { type ComponentChildren, type FunctionComponent, h } from "preact"
import { preactAdapter } from "../src/index.ts"

// SSR side runs under bun (preact-render-to-string/stream). Full hydration is browser-verified
// against the real packages (see examples/web-preact) — bun:test has no DOM. Suspense streaming
// order is Preact's behaviour (already proven for the seam by the React adapter + F8 work); these
// tests cover this adapter's own code — the renderToStream wiring drives `compose` through every
// path (single-element, 2-layer, 3-layer), so compose.ts is fully exercised here.

// Drain the adapter's Web ReadableStream to a string.
const toText = (s: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>) =>
  Promise.resolve(s).then((stream) => new Response(stream).text())

// A layout component that renders its child through `props.children` (the `compose` contract).
const makeLayout =
  (marker: string): FunctionComponent =>
  ({ children }: { children?: ComponentChildren }) =>
    h("div", { "data-layout": marker }, [`NAV:${marker}`, children])

// A page component that reads loader data + an extra prop off `props` (what `compose` spreads in).
const Page: FunctionComponent<RenderProps> = (props) =>
  h(
    "p",
    { "data-pending": String(props.pending ?? false) },
    `hi ${(props.data as { name: string }).name}`,
  )

test("renderToStream renders a single-element chain (page only)", async () => {
  const Comp: FunctionComponent = () => h("h1", null, "hello world")
  const html = await toText(preactAdapter.renderToStream([Comp], { data: null }))
  expect(html).toContain("hello world")
  expect(html).toContain("<h1")
})

test("renderToStream folds a layout chain: layout wraps page, data + props reach the page", async () => {
  const html = await toText(
    preactAdapter.renderToStream([makeLayout("outer"), Page], {
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
  const renderToString = preactAdapter.renderToString
  if (renderToString === undefined) throw new Error("preactAdapter.renderToString is missing")
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
    preactAdapter.renderToStream([makeLayout("outer"), makeLayout("inner"), Page], {
      data: { name: "grace" },
    }),
  )
  const outerAt = html.indexOf('data-layout="outer"')
  const innerAt = html.indexOf('data-layout="inner"')
  const pageAt = html.indexOf("hi grace")
  expect(outerAt).toBeGreaterThanOrEqual(0)
  expect(innerAt).toBeGreaterThan(outerAt) // inner is nested inside outer
  expect(pageAt).toBeGreaterThan(innerAt) // page is nested inside inner
})

test("hydrationHead is empty (Preact reconciles the DOM on hydrate; no bootstrap script)", () => {
  expect(preactAdapter.hydrationHead()).toBe("")
})
