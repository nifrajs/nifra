export const loader = (ctx: { readonly request: Request }) => ({
  agent: ctx.request.headers.get("user-agent"),
})
