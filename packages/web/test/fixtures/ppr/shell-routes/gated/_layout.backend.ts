// A gate runs for its redirect or refusal; on a PPR route its data never reaches the shell.
export const gate = true
export const loader = (ctx: { readonly request: Request }) => {
  if (ctx.request.headers.get("cookie") === null) throw new Response(null, { status: 401 })
  return null
}
