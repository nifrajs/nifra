import { productTitle } from "../../shell-lib/catalog.ts"

export const shellLoader = async (ctx: { readonly params: Readonly<Record<string, string>> }) => ({
  title: productTitle(ctx.params.id ?? ""),
})
