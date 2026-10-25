import type { BoundaryStates, RenderProps, RouterState } from "@nifrajs/web"
import { defineComponent, h } from "vue"

// A layout and two pages that declare only the `data` they read.
export const Layout = defineComponent({
  props: ["data"],
  setup:
    (_props, { slots }) =>
    () =>
      h("main", { id: "layout" }, slots.default?.()),
})
const page = (id: string) =>
  defineComponent({ props: ["data"], setup: () => () => h("p", { id }, id) })
export const A = page("a")
export const B = page("b")

export const BOUNDARIES: BoundaryStates = {
  photo: { name: "photo", mode: "static", status: "ready", data: { src: "p" } },
}
const layoutData = [{ layout: 1 }]

/** What the server renders page `a` with. */
export const SERVER_PROPS: RenderProps = {
  data: { page: "a" },
  layoutData,
  boundaries: BOUNDARIES,
  params: {},
  path: "/a",
  search: {},
}

/** The state the client router starts from: the one the server rendered page `a` in. */
export const INITIAL: RouterState = {
  routeId: "a",
  params: {},
  path: "/a",
  data: SERVER_PROPS.data,
  layoutData,
  boundaries: BOUNDARIES,
  pending: false,
}
