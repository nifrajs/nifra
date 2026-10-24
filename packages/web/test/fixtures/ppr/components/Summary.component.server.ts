import { t } from "@nifrajs/schema"
import { defineServerComponent } from "@nifrajs/web/server-components"
import { clientIsland, nativeServerView } from "@nifrajs/web/server-components/islands"
import { counter } from "./Counter.island.ts"
import { countOf } from "./lib/counts.backend.ts"
import SummaryView from "./SummaryView.frontend.ts"

/** The basket of one product, for each visitor. `internal` never reaches the view or a browser. */
export const Summary = defineServerComponent({
  input: t.object({ id: t.string() }),
  props: t.object({ title: t.string() }),
  authorize() {},
  load: (_ctx, input) => ({
    title: `basket ${input.id}: ${countOf(input.id)}`,
    internal: "PRIVATE_FIELD_31",
  }),
  view: () =>
    nativeServerView(SummaryView, { counter: clientIsland(counter, "counter", { start: 0 }) }),
})
