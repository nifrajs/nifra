import { t } from "@nifrajs/schema"
import { defineClientIsland } from "@nifrajs/web/server-components/islands"
import Counter from "./Counter.frontend.svelte"
export const counter = defineClientIsland({
  props: t.object({ title: t.string(), prefix: t.optional(t.string()) }),
  component: Counter,
  slots: ["summary"],
})
