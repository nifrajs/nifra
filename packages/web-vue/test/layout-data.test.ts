import { expect, test } from "bun:test"
import type { RouterState } from "@nifrajs/web"
import { createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { compose } from "../src/compose.ts"
import { routeProps } from "../src/route-props.ts"

/** A layout that renders whatever loader data it was handed, plus its default slot. */
const layout = (marker: string) =>
  defineComponent({
    props: ["data"],
    setup(props, { slots }) {
      return () =>
        h("div", { "data-layout": marker }, [JSON.stringify(props.data), slots.default?.()])
    },
  })

const Page = defineComponent({
  props: ["data"],
  setup(props) {
    return () => h("p", null, JSON.stringify(props.data))
  },
})

const snapshot = (over: Partial<RouterState> = {}): RouterState => ({
  routeId: "org/index",
  params: {},
  path: "/org",
  data: { page: 1 },
  pending: false,
  ...over,
})

// Vue escapes text content, so `{"a":1}` arrives as `{&quot;a&quot;:1}`.
const render = async (state: RouterState): Promise<string> =>
  (
    await renderToString(
      createSSRApp({
        render: () => compose([layout("root"), layout("org"), Page], routeProps(state, undefined)),
      }),
    )
  ).replaceAll("&quot;", String.fromCharCode(34))

test("the mounted Router renders each layout with the snapshot's layout data", async () => {
  // What the client mount renders for a store snapshot. The server rendered these layouts with their
  // data, so a client render that drops it is a hydration mismatch on the first paint.
  const out = await render(snapshot({ layoutData: [{ from: "root" }, { from: "org" }] }))
  expect(out).toContain('data-layout="root">{"from":"root"}')
  expect(out).toContain('data-layout="org">{"from":"org"}')
  expect(out).toContain('{"page":1}')
})

test("a snapshot with no layout data renders the layouts with null", async () => {
  expect("layoutData" in routeProps(snapshot(), undefined)).toBe(false)
  expect(await render(snapshot())).toContain('data-layout="root">null')
})
