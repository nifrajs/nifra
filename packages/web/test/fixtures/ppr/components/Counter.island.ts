import { t } from "@nifrajs/schema"
import { defineClientIsland } from "@nifrajs/web/server-components/islands"
import Counter from "./Counter.frontend.ts"

export const counter = defineClientIsland({
  props: t.object({ start: t.number() }),
  component: Counter,
})
