import { t } from "@nifrajs/schema"
import { productTitle } from "../shell-lib/catalog.ts"
import { sessionUser } from "../shell-lib/session.ts"

export const shellLoader = async () => ({ title: productTitle("1") })
// The hole reads the visitor, and its schema is a call the bundler keeps; neither is shell code.
export const boundaryLoaders = {
  greeting: {
    load: (ctx: { request: Request }) => sessionUser(ctx.request),
    output: t.object({ name: t.string() }),
  },
}
