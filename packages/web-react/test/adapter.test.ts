import { expect, test } from "bun:test"
import { createElement, type ReactNode, Suspense, use } from "react"
import { reactAdapter } from "../src/index.ts"

// SSR side runs under bun (react-dom/server). Full hydration is browser-verified against
// the real packages (see examples/web-react) — bun:test has no DOM.

// Drain the adapter's stream (React resolves it on shell-ready) to a string.
const toText = (s: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>) =>
  Promise.resolve(s).then((stream) => new Response(stream).text())

test("renderToStream renders a single-element chain (page only)", async () => {
  const Comp = () => createElement("h1", null, "hello world")
  const html = await toText(reactAdapter.renderToStream([Comp], { data: null }))
  expect(html).toContain("hello world")
  expect(html).toContain("<h1")
})

test("renderToStream folds a layout chain: layout wraps page, data reaches the page", async () => {
  const Layout = (props: { children: ReactNode }) =>
    createElement("div", { "data-layout": "" }, "NAV", props.children)
  const Page = (props: { data: unknown }) =>
    createElement("p", null, `hi ${(props.data as { name: string }).name}`)
  const html = await toText(reactAdapter.renderToStream([Layout, Page], { data: { name: "ada" } }))
  expect(html).toContain("data-layout") // the layout rendered
  expect(html).toContain("NAV") // the layout's own content
  expect(html).toContain("hi ada") // the page, with data, nested inside the layout
})

test("renderToString folds the same layout chain for the non-deferred fast path", async () => {
  const renderToString = reactAdapter.renderToString
  if (renderToString === undefined) throw new Error("reactAdapter.renderToString is missing")
  const Layout = (props: { children: ReactNode }) =>
    createElement("section", { "data-layout": "sync" }, props.children)
  const Page = (props: { data: unknown }) =>
    createElement("p", null, `hi ${(props.data as { name: string }).name}`)
  const html = await renderToString([Layout, Page], { data: { name: "ada" } })
  expect(html).toContain('data-layout="sync"')
  expect(html).toContain("hi ada")
})

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
