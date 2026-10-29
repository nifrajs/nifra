import { t } from "@nifrajs/schema"
import { visitorName } from "../../../../../../web/test/fixtures/ppr/app/lib/session.ts"

export const shellLoader = (ctx: { readonly params: Readonly<Record<string, string>> }) => ({
  title: `Gallery ${ctx.params.id}`,
})
export const shellOutput = t.object({ title: t.string() })

export const boundaryLoaders = {
  greeting: {
    load: (ctx: { readonly request: Request }) => ({ name: visitorName(ctx.request) }),
    output: t.object({ name: t.string() }),
  },
  cart: { load: () => ({ count: 2 }), output: t.object({ count: t.number() }) },
}
