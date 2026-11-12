import { t } from "@nifrajs/schema"
import { probe } from "../../lib/probe.backend.ts"
import { visitorName } from "../../lib/session.backend.ts"

export const shellLoader = async (ctx: { readonly params: Readonly<Record<string, string>> }) => ({
  title: `Stock ${ctx.params.id}`,
})
export const shellOutput = t.object({ title: t.string() })

export const boundaryLoaders = {
  // The same for every visitor: built once per id and kept for a minute.
  price: {
    load: (ctx: { readonly params: Readonly<Record<string, string>> }) => {
      probe.priceBuilds++
      return { amount: Number(ctx.params.id) * 10 }
    },
    output: t.object({ amount: t.number() }),
    revalidate: 60,
    revalidateTags: ["price"],
  },
  greeting: {
    load: (ctx: { readonly request: Request }) => ({ name: visitorName(ctx.request) }),
    output: t.object({ name: t.string() }),
  },
}
