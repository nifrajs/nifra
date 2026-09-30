import { expect, test } from "bun:test"
import type { RouterState } from "@nifrajs/web"
import { type ComponentChildren, h } from "preact"
import { renderToString } from "preact-render-to-string"
import { compose } from "../src/compose.ts"
import { routeProps } from "../src/route-props.ts"

/** A layout that renders whatever loader data it was handed, plus its children. */
const layout = (marker: string) => (props: { data: unknown; children?: ComponentChildren }) =>
  h("div", { "data-layout": marker }, JSON.stringify(props.data), props.children)

const Page = (props: { data: unknown }) => h("p", null, JSON.stringify(props.data))

const snapshot = (over: Partial<RouterState> = {}): RouterState => ({
  routeId: "org/index",
  params: {},
  path: "/org",
  data: { page: 1 },
  pending: false,
  ...over,
})

// Preact escapes text content, so `{"a":1}` arrives as `{&quot;a&quot;:1}`.
const render = (state: RouterState): string =>
  renderToString(
    compose([layout("root"), layout("org"), Page], routeProps(state, undefined)),
  ).replaceAll("&quot;", String.fromCharCode(34))

test("the mounted Router renders each layout with the snapshot's layout data", () => {
  // What the client mount renders for a store snapshot. The server rendered these layouts with their
  // data, so a client render that drops it is a hydration mismatch on the first paint.
  const out = render(snapshot({ layoutData: [{ from: "root" }, { from: "org" }] }))
  expect(out).toContain('data-layout="root">{"from":"root"}')
  expect(out).toContain('data-layout="org">{"from":"org"}')
  expect(out).toContain('{"page":1}')
})

test("a snapshot with no layout data renders the layouts with null", () => {
  expect("layoutData" in routeProps(snapshot(), undefined)).toBe(false)
  expect(render(snapshot())).toContain('data-layout="root">null')
})
