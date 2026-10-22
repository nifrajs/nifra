import { t } from "@nifrajs/schema"
import { defineServerComponent } from "@nifrajs/web/server-components"
import { createElement } from "react"
import { Counter } from "./frontend/Counter.tsx"
import { countOf } from "./lib/counts.backend.ts"

/** In a client file, this text would mean the hole's view left the server. */
const MARKER = "server-only basket view 5c1f"

/** The basket of one product, for each visitor. `internal` never reaches the view or a browser. */
export const Summary = defineServerComponent({
  input: t.object({ id: t.string() }),
  props: t.object({ title: t.string() }),
  authorize() {},
  load: (_ctx, input) => ({
    title: `basket ${input.id}: ${countOf(input.id)}`,
    internal: "PRIVATE_FIELD_31",
  }),
  view: ({ props }) =>
    createElement(
      "section",
      { id: "summary", "data-view": MARKER },
      createElement("h2", { id: "summary-title" }, props.title),
      createElement(Counter, { start: 0 }),
    ),
})
