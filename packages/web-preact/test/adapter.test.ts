import { expect, test } from "bun:test"
import { assertRenderAdapterConformance, type RenderProps } from "@nifrajs/web"
import { type ComponentChildren, type FunctionComponent, h } from "preact"
import { preactAdapter } from "../src/index.ts"

// SSR side runs under bun (preact-render-to-string/stream). Full hydration is browser-verified
// against the real packages (see examples/web-preact) - bun:test has no DOM. Suspense streaming
// order is Preact's behaviour (already proven for the seam by the React adapter + F8 work); these
// framework-specific hydration behaviour stays local; shared render invariants run below.

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

test("preactAdapter conforms to the executable RenderAdapter interface", async () => {
  await assertRenderAdapterConformance(preactAdapter, {
    page: Page,
    outerLayout: makeLayout("outer"),
    innerLayout: makeLayout("inner"),
    props: { data: { name: "conformance-data" }, pending: true },
    markers: {
      page: "<p",
      data: "conformance-data",
      pending: 'data-pending="true"',
      outer: 'data-layout="outer"',
      inner: 'data-layout="inner"',
    },
  })
})

test("hydrationHead is empty (Preact reconciles the DOM on hydrate; no bootstrap script)", () => {
  expect(preactAdapter.hydrationHead()).toBe("")
})

test("renderToString returns synchronously after the renderer is warmed", async () => {
  const renderToString = preactAdapter.renderToString
  if (renderToString === undefined) throw new Error("preactAdapter must provide renderToString")

  await renderToString([Page], { data: { name: "warmup" } })

  const rendered = renderToString([Page], { data: { name: "sync" } })

  expect(rendered).not.toBeInstanceOf(Promise)
  expect(rendered).toContain("hi sync")
})

test("renderToStream stamps the nonce on Preact's streamed island runtime, and only on it", async () => {
  const { Suspense } = await import("preact/compat")
  // A fresh suspender per render: each one throws its pending promise once, then renders the value.
  const app = (): FunctionComponent => {
    let settled = false
    const slow = new Promise<void>((r) =>
      setTimeout(() => {
        settled = true
        r()
      }, 30),
    )
    const Slow: FunctionComponent = () => {
      if (!settled) throw slow
      return h("span", null, "RESOLVED")
    }
    // An app-rendered script must not inherit the framework's nonce.
    return () =>
      h("div", null, [
        h("script", { dangerouslySetInnerHTML: { __html: "window.app=1" } }),
        h(Suspense, { fallback: "FALLBACK" }, h(Slow, null)),
      ])
  }
  const read = async (options?: { nonce: string }) =>
    new Response(await preactAdapter.renderToStream([app()], { data: null }, options)).text()
  const nonced = await read({ nonce: 'n"0' })
  expect(nonced).toContain("RESOLVED")
  expect(nonced).toContain('<script nonce="n&quot;0">(function(){')
  expect(nonced).toContain("<script>window.app=1</script>")
  expect(nonced.match(/nonce=/g)?.length).toBe(1)
  expect(await read()).not.toContain("nonce=")
})

test("renderToStream leaves an app script that opens like the island runtime un-nonced", async () => {
  // Same opening bytes as Preact's streamed runtime, but no `preact-island` definition inside.
  const Page: FunctionComponent = () =>
    h("script", { dangerouslySetInnerHTML: { __html: "(function(){window.app=2})()" } })
  const html = await new Response(
    await preactAdapter.renderToStream([Page], { data: null }, { nonce: "n0" }),
  ).text()
  expect(html).toBe("<script>(function(){window.app=2})()</script>")
})
