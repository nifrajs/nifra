import { t } from "@nifrajs/schema"

// A gate refuses before the shell is looked up; on a PPR route its data reaches no response.
export const gate = true
export const loader = (ctx: { readonly request: Request }) => {
  if (ctx.request.headers.get("cookie") === null)
    throw new Response("members only", { status: 401 })
  return { member: true }
}
export const loaderOutput = t.object({ member: t.boolean() })
