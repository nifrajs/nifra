import { t } from "@nifrajs/schema"
import { defer } from "@nifrajs/web"
import { loadCart, loadGreeting, loadRecs, readProduct } from "../../../backend/catalog.ts"
import { cartSchema, greetingSchema, productSchema, recsSchema } from "../../../shared/catalog.ts"

export const loaderOutput = t.object({
  product: productSchema,
  greeting: t.deferred(greetingSchema),
  cart: t.deferred(cartSchema),
  recs: t.deferred(recsSchema),
})

export async function loader(ctx: {
  readonly params: Record<string, string>
  readonly request: Request
}) {
  const greeting = loadGreeting(ctx.request)
  const cart = loadCart(ctx.request)
  const recs = loadRecs(ctx.request)
  return {
    product: await readProduct(ctx.params.id ?? "0"),
    greeting: defer(greeting),
    cart: defer(cart),
    recs: defer(recs),
  }
}
