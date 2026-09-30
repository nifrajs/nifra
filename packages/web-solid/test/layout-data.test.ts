import { expect, test } from "bun:test"
import type { RouterState } from "@nifrajs/web"
import type { JSX } from "solid-js"
import { renderToString } from "solid-js/web"
import { compose } from "../src/compose.ts"
import { routeProps } from "../src/route-props.ts"

/** A layout that renders whatever loader data it was handed, around its children. */
const layout = (marker: string) => (props: { data: unknown; children?: JSX.Element }) =>
  [`<${marker}:${JSON.stringify(props.data)}>`, props.children] as unknown as JSX.Element

const Page = (props: { data: unknown }) => `[page:${JSON.stringify(props.data)}]`

const snapshot = (over: Partial<RouterState> = {}): RouterState => ({
  routeId: "org/index",
  params: {},
  path: "/org",
  data: { page: 1 },
  pending: false,
  ...over,
})

// Solid escapes text content, so `<` and `"` arrive as entities.
const decode = (html: string): string =>
  html.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", String.fromCharCode(34))

test("the mounted Router renders each layout with the snapshot's layout data", () => {
  // What the client mount renders for a store snapshot. The server rendered these layouts with their
  // data, so a client render that drops it is a hydration mismatch on the first paint.
  const state = snapshot({ layoutData: [{ from: "root" }, { from: "org" }] })
  const props = routeProps(() => state, undefined)
  const out = decode(renderToString(compose([layout("root"), layout("org"), Page], props)))
  expect(out).toContain('<root:{"from":"root"}>')
  expect(out).toContain('<org:{"from":"org"}>')
  expect(out).toContain('[page:{"page":1}]')
})

test("the props follow the snapshot, so a same-route settle reaches the layouts", () => {
  // The props are getters over the snapshot accessor and `compose` reads a layout's data through a
  // getter of its own, so new layout data arrives without re-composing the chain.
  let state = snapshot({ layoutData: [{ n: 1 }] })
  const props = routeProps(() => state, undefined)
  let seen: { readonly data: unknown } | undefined
  const Probe = (layoutProps: { data: unknown; children?: JSX.Element }) => {
    seen = layoutProps
    return layoutProps.children
  }
  renderToString(compose([Probe, Page], props))
  expect(seen?.data).toEqual({ n: 1 })
  state = snapshot({ layoutData: [{ n: 2 }] })
  expect(props.layoutData).toEqual([{ n: 2 }])
  expect(seen?.data).toEqual({ n: 2 })
})

test("a snapshot with no layout data renders the layouts with null", () => {
  const state = snapshot()
  const props = routeProps(() => state, undefined)
  expect(props.layoutData).toBeUndefined()
  expect(decode(renderToString(compose([layout("root"), Page], props)))).toContain("<root:null>")
})
