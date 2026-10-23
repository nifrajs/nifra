import { defineComponent, h, ref } from "vue"

/** A client island: clicks only the browser counts, from a start the server gives. */
export default defineComponent({
  props: {
    start: { type: Number, required: true },
    slots: { type: Object, required: false },
  },
  setup(props) {
    const clicks = ref(props.start)
    return () =>
      h(
        "button",
        { id: "island", type: "button", onClick: () => clicks.value++ },
        `clicked ${clicks.value}`,
      )
  },
})
