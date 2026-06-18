import { h, type VNode } from "preact"
import type { CatalogPageData } from "../shared/catalog.ts"

export function App(props: { data: CatalogPageData }): VNode {
  return h(
    "main",
    null,
    h("h1", null, `Items (${props.data.items.length})`),
    h(
      "ul",
      null,
      props.data.items.map((it) => h("li", { key: it.id }, it.name)),
    ),
  )
}
