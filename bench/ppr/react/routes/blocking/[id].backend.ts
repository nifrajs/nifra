import { t } from "@nifrajs/schema"
import {
  cartSchema,
  greetingSchema,
  loadCart,
  loadGreeting,
  loadRecs,
  productSchema,
  readProduct,
  recsSchema,
} from "../../../shared/catalog.ts"

export const loaderOutput = t.object({
  product: productSchema,
  greeting: greetingSchema,
  cart: cartSchema,
  recs: recsSchema,
})

// The per-visitor parts start before the product read, as the PPR route's holes do.
export async function loader(ctx: {
  readonly params: Record<string, string>
  readonly request: Request
}) {
  const greeting = loadGreeting(ctx.request)
  const cart = loadCart(ctx.request)
  const recs = loadRecs(ctx.request)
  return {
    product: await readProduct(ctx.params.id ?? "0"),
    greeting: await greeting,
    cart: await cart,
    recs: await recs,
  }
}
