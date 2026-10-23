import { t } from "@nifrajs/schema"

export const shellLoader = async (ctx: { readonly params: Readonly<Record<string, string>> }) => ({
  id: ctx.params.id ?? "",
})
export const shellOutput = t.object({ id: t.string() })

export const boundaryLoaders = {
  note: { load: () => ({ text: "for members" }), output: t.object({ text: t.string() }) },
}
