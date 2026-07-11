import { expect, test } from "bun:test"
import { assertRenderAdapterConformance } from "@nifrajs/web"
import { defineComponent, h } from "vue"
import { vueAdapter } from "../src/index.ts"

// SSR side runs under bun (vue/server-renderer). Full hydration is browser-verified against the
// real packages (see examples/web-vue) — bun:test has no DOM. Unlike React, Vue SSR resolves
// async deps before flushing (no fallback-then-content boundary semantics), so there is no
// streaming-order test here — Vue's `renderToWebStream` chunks the serialized buffer, it does
// not progressively render Suspense fallbacks the way React's `renderToReadableStream` does.

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

test("vueAdapter conforms to the executable RenderAdapter interface", async () => {
  await assertRenderAdapterConformance(vueAdapter, {
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

test("hydrationHead is empty (Vue reconciles the DOM on createSSRApp; no bootstrap script)", () => {
  expect(vueAdapter.hydrationHead()).toBe("")
})
