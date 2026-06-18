import { defineComponent, h } from "vue"
import type { CatalogPageData } from "../shared/catalog.ts"

export const App = defineComponent({
  props: { data: { type: Object, required: true } },
  setup(props: { data: CatalogPageData }) {
    return () =>
      h("main", [
        h("h1", `Items (${props.data.items.length})`),
        h(
          "ul",
          props.data.items.map((it) => h("li", { key: it.id }, it.name)),
        ),
      ])
  },
})
