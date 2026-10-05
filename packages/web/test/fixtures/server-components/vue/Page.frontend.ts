import { createServerComponentOutlet } from "@nifrajs/web-vue/server-components/outlet"
import { defineComponent, h, ref } from "vue"
import { Summary } from "./Summary.component.server"

const SummaryOutlet = createServerComponentOutlet(Summary)
export default defineComponent({
  props: ["state", "controller", "clientAdapter"],
  setup(props) {
    const count = ref(0)
    return () =>
      h("main", [
        h(
          "button",
          { id: "parent-counter", onClick: () => count.value++ },
          `Parent ${count.value}`,
        ),
        h(SummaryOutlet, {
          state: props.state,
          controller: props.controller,
          clientAdapter: props.clientAdapter,
          instanceKey: "summary",
          input: {},
        }),
      ])
  },
})
