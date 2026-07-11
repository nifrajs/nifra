import { expect, test } from "bun:test"
import { assertRenderAdapterConformance, type RenderProps } from "@nifrajs/web"
import { type ComponentChildren, type FunctionComponent, h } from "preact"
import { preactAdapter } from "../src/index.ts"

// SSR side runs under bun (preact-render-to-string/stream). Full hydration is browser-verified
// against the real packages (see examples/web-preact) — bun:test has no DOM. Suspense streaming
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
