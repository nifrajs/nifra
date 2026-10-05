import { t } from "@nifrajs/schema"
export const Counter = t.object({ title: t.string(), prefix: t.optional(t.string()) })
export const CounterSlots = ["summary"] as const
