import { expect, test } from "bun:test"
import { createElement, type ReactNode } from "react"
import { compose } from "../src/compose.ts"
import { reactAdapter } from "../src/index.ts"

const html = async (node: ReactNode): Promise<string> => {
  const stream = await reactAdapter.renderToStream([() => node], { data: null })
  // React escapes text content, so `{"a":1}` arrives as `{&quot;a&quot;:1}`. Decode the one entity
  // that matters here so the assertions read as the JSON they are about.
  return (await new Response(stream).text()).replaceAll("&quot;", String.fromCharCode(34))
}

/** A layout that renders whatever loader data it was handed, plus its children. */
const layout = (marker: string) => (props: { data: unknown; children?: ReactNode }) =>
  createElement("div", { "data-layout": marker }, JSON.stringify(props.data), props.children)

const Page = (props: { data: unknown }) =>
  createElement("p", { "data-page": "1" }, JSON.stringify(props.data))

test("each layout renders its OWN loader data", async () => {
  const node = compose([layout("root"), layout("org"), Page], {
    data: { page: 1 },
    layoutData: [{ from: "root" }, { from: "org" }],
  })
  const out = await html(node)
  // The failure this guards against is a layout rendering a sibling's data, which reads as a data
  // bug for a long time before it reads as a router bug.
  expect(out).toContain('data-layout="root"')
  expect(out).toContain('{"from":"root"}')
  expect(out).toContain('data-layout="org"')
  expect(out).toContain('{"from":"org"}')
  expect(out).toContain('{"page":1}')
})

test("a layout with no loader gets null, not the page's data", async () => {
  const node = compose([layout("root"), Page], {
    data: { page: 1 },
    layoutData: [null],
  })
  const out = await html(node)
  expect(out).toContain('data-layout="root">null')
  expect(out).toContain('{"page":1}')
})

test("no layoutData at all leaves layouts exactly as before", async () => {
  // A page-only app, and any adapter usage predating this feature.
  const out = await html(compose([layout("root"), Page], { data: { page: 1 } }))
  expect(out).toContain('data-layout="root">null')
  expect(out).toContain('{"page":1}')
})

test("an entry past the layout prefix is ignored rather than mis-indexed", async () => {
  // The client inserts an `_error` boundary marker AFTER the layouts, so positional indexing must
  // simply run out rather than shift.
  const node = compose([layout("root"), layout("mid"), Page], {
    data: null,
    layoutData: [{ only: "root" }],
  })
  const out = await html(node)
  expect(out).toContain('{"only":"root"}')
  expect(out).toContain('data-layout="mid">null')
})
