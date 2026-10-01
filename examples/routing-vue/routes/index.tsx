import type { ActionData, LoaderData } from "@nifrajs/client"
import { Await } from "@nifrajs/web-vue/await"
import { defineComponent, h } from "vue"
import type { action, loader } from "./index.backend.ts"

// Static head for this route - SSR-injected + updated on client navigation.
export const meta = {
  title: "nifra + Vue - Home",
  meta: [{ name: "description", content: "nifra Vue bindings: loader + action + defer/Await" }],
}

export default defineComponent({
  name: "Home",
  // compose() passes data/actionData/pending/submission as props - declare them so they aren't attrs.
  props: {
    data: { required: true },
    actionData: { required: false, default: undefined },
    pending: { required: false, default: false },
    submission: { required: false, default: undefined },
  },
  setup(props) {
    return () => {
      const data = props.data as LoaderData<typeof loader>
      const actionData = props.actionData as ActionData<typeof action> | undefined
      return h("div", null, [
        h("h1", { id: "page" }, "Home"),
        h("p", { id: "count" }, `count: ${data.count}`),
        h("form", { method: "post" }, h("button", { id: "inc", type: "submit" }, "increment")),
        // After a submit, the action's deferred receipt resolves into <Await> (client-side on Vue).
        actionData
          ? h(
              Await,
              { resolve: actionData.receipt },
              {
                default: (receipt: string) => h("p", { id: "receipt" }, receipt),
                fallback: () => h("p", { id: "receipt-fallback" }, "receipt…"),
              },
            )
          : null,
      ])
    }
  },
})
