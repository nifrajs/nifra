import { t } from "@nifrajs/schema"
import { defineServerComponent, inheritOwnerAuthorization } from "@nifrajs/web/server-components"
import { createElement as el, Fragment } from "react"
import { Counter } from "./frontend/Client"
export const Child = defineServerComponent({
  input: t.object({}),
  props: t.object({ title: t.string(), revision: t.number(), islandKey: t.number() }),
  authorize: inheritOwnerAuthorization,
  load: (ctx) => ctx.data,
  view({ props }) {
    return el(
      Fragment,
      {},
      "child-leading",
      el(
        "table",
        {},
        el(
          "tbody",
          {},
          el("tr", {}, el("td", { id: "child-revision" }, `Child ${props.revision}`)),
        ),
      ),
      el("svg", {}, el("circle", { id: "child-svg", cx: 1 })),
      el(Counter, { title: `Child ${props.revision}`, prefix: "child-" }),
      "child-trailing",
    )
  },
})
