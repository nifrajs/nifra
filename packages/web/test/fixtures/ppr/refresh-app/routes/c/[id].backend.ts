import { t } from "@nifrajs/schema"
import { add, countOf } from "../../lib/counts.ts"

export const shellLoader = async (ctx: { readonly params: Readonly<Record<string, string>> }) => ({
  title: `Cart ${ctx.params.id}`,
})
export const shellOutput = t.object({ title: t.string() })

/** Both holes read the cart's count and watch its key. */
const load = (ctx: {
  readonly params: Readonly<Record<string, string>>
  readonly live: (...keys: string[]) => void
}) => {
  ctx.live(`cart:${ctx.params.id}`)
  return { count: countOf(ctx.params.id ?? "") }
}

export const boundaryLoaders = {
  basket: { load, output: t.object({ count: t.number() }) },
  note: { load, output: t.object({ count: t.number() }) },
}

export const action = (ctx: { readonly params: Readonly<Record<string, string>> }) => ({
  count: add(ctx.params.id ?? ""),
})
export const actionOutput = t.object({ count: t.number() })
