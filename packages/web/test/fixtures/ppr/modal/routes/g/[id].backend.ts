import { t } from "@nifrajs/schema"
import { visitorName } from "../../../app/lib/session.backend.ts"

export const shellLoader = (ctx: { readonly params: Readonly<Record<string, string>> }) => ({
  title: `Gallery ${ctx.params.id}`,
})
export const shellOutput = t.object({ title: t.string() })

export const boundaryLoaders = {
  greeting: {
    load: (ctx: { readonly request: Request }) => ({ name: visitorName(ctx.request) }),
    output: t.object({ name: t.string() }),
  },
}
