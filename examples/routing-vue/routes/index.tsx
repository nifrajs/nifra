import { Await } from "@nifrajs/web-vue/await"
import { defineComponent, h } from "vue"
import type { Route } from "./+types/index"

// Static head for this route - SSR-injected + updated on client navigation.
export const meta = {
  title: "nifra + Vue - Home",
  meta: [{ name: "description", content: "nifra Vue bindings: loader + action + defer/Await" }],
}

export default defineComponent(
  (props: Route.ComponentProps) => () =>
    h("div", null, [
      h("h1", { id: "page" }, "Home"),
      h("p", { id: "count" }, `count: ${props.data.count}`),
      h("form", { method: "post" }, h("button", { id: "inc", type: "submit" }, "increment")),
      // After a submit, the action's deferred receipt resolves into <Await> (client-side on Vue).
      props.actionData
        ? h(
            Await,
            { resolve: props.actionData.receipt },
            {
              default: (receipt: string) => h("p", { id: "receipt" }, receipt),
              fallback: () => h("p", { id: "receipt-fallback" }, "receipt…"),
            },
          )
        : null,
    ]),
  // A page gets only the route props it declares.
  { name: "Home", props: ["data", "actionData"] },
)
