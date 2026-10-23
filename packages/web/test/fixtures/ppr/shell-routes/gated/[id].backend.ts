export const shellLoader = async (ctx: { readonly params: Readonly<Record<string, string>> }) => ({
  id: ctx.params.id ?? "",
})
