/** The chain `share-browser.test.ts` renders on the server and mounts in the browser. */
import { defineComponent, h, type PropType } from "vue"

type Row = { readonly id: number; readonly label: string }
type Counts = { layout: number; page: number; rows: number }
// The browser entry installs the counters; a server render counts into a throwaway.
const counts = (): Counts =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the browser entry is the only writer of this global
  (Reflect.get(globalThis, "shareCounts") as Counts | undefined) ?? { layout: 0, page: 0, rows: 0 }

export const Layout = defineComponent({
  props: { data: { type: Object, default: null } },
  setup(_props, { slots }) {
    return () => {
      counts().layout++
      return h("main", null, slots.default?.())
    }
  },
})

// A child component: Vue skips one whose props kept their identity.
const RowView = defineComponent({
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `PropType` is how Vue types an object prop; the page passes this shape
  props: { row: { type: Object as PropType<Row>, required: true } },
  setup(props) {
    return () => {
      counts().rows++
      return h("li", { "data-id": props.row.id }, [
        h("input", { type: "checkbox" }),
        props.row.label,
      ])
    }
  },
})

export const Page = defineComponent({
  props: {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `PropType` is how Vue types an object prop; the page passes this shape
    data: { type: Object as PropType<{ readonly items: readonly Row[] }>, required: true },
    pending: { type: Boolean, default: false },
  },
  setup(props) {
    return () => {
      counts().page++
      return h(
        "ul",
        null,
        props.data.items.map((row) => h(RowView, { key: row.id, row })),
      )
    }
  },
})
