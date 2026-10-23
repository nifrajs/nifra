import { defineComponent, h } from "vue"

/** In a client file, this text would mean the hole's view left the server. */
const MARKER = "server-only basket view 5c1f"

/** The hole's server component view: its title, and the island the server rendered for it. */
export default defineComponent({
  props: {
    props: { type: Object, required: true },
    islands: { type: Object, required: true },
    ranges: { type: Object, required: false },
  },
  setup(view) {
    return () =>
      h("section", { id: "summary", "data-view": MARKER }, [
        h("h2", { id: "summary-title" }, String(view.props.title)),
        h("div", { innerHTML: String(view.islands.counter.html) }),
      ])
  },
})
