import { t } from "@nifrajs/schema"

export const loader = (ctx: { readonly params: Readonly<Record<string, string>> }) => ({
  title: `Photo ${ctx.params.id}`,
})
export const loaderOutput = t.object({ title: t.string() })
