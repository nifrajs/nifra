import { defineComponent, h, ref } from "vue"

export interface PageData {
  message: string
  start: number
}

// A Vue route component (render function — no SFC compiler needed). `data` is the loader output;
// the ref-backed counter proves hydration (it's interactive only after the client hydrates).
export const App = defineComponent({
  props: { data: { type: Object, required: true } },
  setup(props: { data: PageData }) {
    const count = ref(props.data.start)
    return () =>
      h("main", [
        h("h1", props.data.message),
        h(
          "button",
          { id: "btn", type: "button", onClick: () => count.value++ },
          `count: ${count.value}`,
        ),
      ])
  },
})
