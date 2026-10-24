import { t } from "@nifrajs/schema"
import type { LoaderContext } from "@nifrajs/web"
import { add } from "../../lib/counts.backend.ts"

type Params = { readonly params: Readonly<Record<string, string>> }

export const shellLoader = (ctx: Params) => ({ title: `Product ${ctx.params.id}` })
export const shellOutput = t.object({ title: t.string() })
export const revalidate = 60

/** The hole's loader returns its server component's input, which reaches the browser in its record. */
export const boundaryLoaders = {
  summary: {
    load: (ctx: Params) => ({ id: ctx.params.id ?? "" }),
    output: t.object({ id: t.string() }),
  },
}

export const action = (ctx: LoaderContext) => {
  add(ctx.params.id ?? "")
  return { added: true }
}
export const actionOutput = t.object({ added: t.boolean() })
