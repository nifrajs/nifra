import { expect, test } from "bun:test"
import { assertRenderAdapterConformance } from "@nifrajs/web"
import { createElement, type ReactNode, Suspense, use } from "react"
import { reactAdapter } from "../src/index.ts"

test("reactAdapter conforms to the executable RenderAdapter interface", async () => {
  const layout = (marker: string) => (props: { children: ReactNode }) =>
    createElement("section", { "data-layout": marker }, props.children)
  const Page = (props: { data: unknown; pending?: boolean }) =>
    createElement(
      "p",
      { "data-page": "leaf", "data-pending": String(props.pending) },
      (props.data as { name: string }).name,
    )
  await assertRenderAdapterConformance(reactAdapter, {
    page: Page,
    outerLayout: layout("outer"),
    innerLayout: layout("inner"),
    props: { data: { name: "conformance-data" }, pending: true },
    markers: {
      page: 'data-page="leaf"',
      data: "conformance-data",
      pending: 'data-pending="true"',
      outer: 'data-layout="outer"',
      inner: 'data-layout="inner"',
    },
  })
})

// SSR side runs under bun (react-dom/server). Full hydration is browser-verified against
// the real packages (see examples/web-react) — bun:test has no DOM.

test("renderToStream streams a Suspense boundary: the shell's fallback flushes before content", async () => {
  // 100ms keeps the boundary pending past the shell flush (React inlines a *fast*-resolving
  // boundary instead of emitting a fallback). Read chunk-by-chunk — the first chunk is the
  // shell (fallback); the resolved content arrives in a later chunk — which proves streaming.
  const slow = new Promise<string>((r) => setTimeout(() => r("RESOLVED"), 100))
  const Slow = () => createElement("span", null, use(slow))
  // Content outside the boundary (the "SHELL") makes React flush the shell + fallback immediately
  // instead of waiting — mirrors the /slow route's <h1> sitting outside <Suspense>.
  const App = () =>
    createElement(
      "div",
      null,
      createElement("h1", null, "SHELL"),
      createElement(
        Suspense,
        { fallback: createElement("span", null, "FALLBACK") },
        createElement(Slow),
      ),
    )
  const stream = await reactAdapter.renderToStream([App], { data: null })
  const reader = stream.getReader()
  const dec = new TextDecoder()
  const order: string[] = []
  let sawContent = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = dec.decode(value)
    if (!order.includes("fallback") && chunk.includes("FALLBACK")) order.push("fallback")
    if (!sawContent && chunk.includes("RESOLVED")) {
      order.push("content")
      sawContent = true
    }
  }
  expect(sawContent).toBe(true) // the resolved content streamed in
  expect(order[0]).toBe("fallback") // ...after the fallback (the shell flushed first)
})

test("hydrationHead is empty (React reconciles the DOM; no bootstrap script)", () => {
  expect(reactAdapter.hydrationHead()).toBe("")
})
