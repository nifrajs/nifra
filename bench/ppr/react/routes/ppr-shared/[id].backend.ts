import { t } from "@nifrajs/schema"
import type { BoundaryRequestCtx, ShellCtx } from "@nifrajs/web"
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
  relatedSchema,
} from "../../../shared/catalog.ts"

// The related list leaves the shell for its shared hole.
export const shellLoader = defineShellLoader(async ({ params }) => ({
  product: { ...(await readProduct(params.id ?? "0")), related: [] },
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
  related: {
    load: async (ctx: ShellCtx) => ({ items: (await readProduct(ctx.params.id ?? "0")).related }),
    output: relatedSchema,
    revalidate: 3600,
  },
}
