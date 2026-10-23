import { t } from "@nifrajs/schema"
import type { BoundaryRequestCtx } from "@nifrajs/web"
import { defineShellLoader } from "@nifrajs/web/ppr"
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

export const shellLoader = defineShellLoader(async ({ params }) => ({
  product: await readProduct(params.id ?? "0"),
}))
export const shellOutput = t.object({ product: productSchema })
export const revalidate = 3600

export const boundaryLoaders = {
  greeting: {
    load: (ctx: BoundaryRequestCtx) => loadGreeting(ctx.request),
    output: greetingSchema,
  },
  cart: { load: (ctx: BoundaryRequestCtx) => loadCart(ctx.request), output: cartSchema },
  recs: { load: (ctx: BoundaryRequestCtx) => loadRecs(ctx.request), output: recsSchema },
}
