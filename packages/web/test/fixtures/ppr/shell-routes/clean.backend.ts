import { productTitle } from "../shell-lib/catalog.ts"
import { sessionUser } from "../shell-lib/session.ts"

export const shellLoader = async () => ({ title: productTitle("1") })
// The hole reads the visitor; tree-shaking keeps session.ts out of the shell bundle.
export const boundaryLoaders = {
  greeting: { load: (ctx: { request: Request }) => sessionUser(ctx.request) },
}
