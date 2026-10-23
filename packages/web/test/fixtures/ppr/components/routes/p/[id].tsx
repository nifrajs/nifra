import type { BoundaryStates } from "@nifrajs/web"
import { serverHole } from "@nifrajs/web/server-components/hole"
import { Hole } from "@nifrajs/web-vue/ppr"
import { defineComponent, h } from "vue"
import { Summary } from "../../Summary.component.server.ts"

const summary = {
  name: "summary",
  mode: "dynamic" as const,
  render: serverHole(Summary),
  fallback: h("p", { id: "summary-fallback" }, "loading the basket"),
}

export const boundaries = [summary]

export default defineComponent(
  (props: { readonly data: { readonly title: string }; readonly boundaries?: BoundaryStates }) =>
    () =>
      h("main", [
        h("h1", { id: "title" }, props.data.title),
        h(
          "p",
          "Every visitor gets this text from the shared shell at once. The basket below is one " +
            "visitor's: a server component renders it on the server for each request, and only the " +
            "button inside it, a client island, ever reaches the browser as code.",
        ),
        h(Hole, { of: summary, state: props.boundaries?.summary }),
        h("form", { method: "post" }, [h("button", { id: "add", type: "submit" }, "Add one")]),
      ]),
  { props: ["data", "boundaries"] },
)
