import { defineComponent, h } from "vue"

/** A page with no holes: a document that starts here has no PPR runtime. */
export default defineComponent(
  () => () => h("main", [h("h1", "Home"), h("a", { id: "to-product", href: "/p/2" }, "A product")]),
)
