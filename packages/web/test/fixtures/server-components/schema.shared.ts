import { t } from "@nifrajs/schema"
export const summaryProps = t.object({
  title: t.string(),
  revision: t.integer(),
  islandKey: t.integer(),
})
export type SummaryProps = NonNullable<(typeof summaryProps)["~standard"]["types"]>["output"]
