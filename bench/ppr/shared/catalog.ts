import { t } from "@nifrajs/schema"

/** Browser-safe catalog types and wire schemas. Runtime reads live in ../backend/catalog.ts. */
export interface Product {
  readonly id: string
  readonly name: string
  readonly price: string
  readonly description: string
  readonly specs: readonly { readonly k: string; readonly v: string }[]
  readonly related: readonly {
    readonly id: string
    readonly name: string
    readonly price: string
  }[]
}

export const productSchema = t.object({
  id: t.string(),
  name: t.string(),
  price: t.string(),
  description: t.string(),
  specs: t.array(t.object({ k: t.string(), v: t.string() })),
  related: t.array(t.object({ id: t.string(), name: t.string(), price: t.string() })),
})

export const relatedSchema = t.object({
  items: t.array(t.object({ id: t.string(), name: t.string(), price: t.string() })),
})

export const greetingSchema = t.object({ name: t.string() })
export const cartSchema = t.object({ count: t.number() })
export const recsSchema = t.object({ items: t.array(t.string()) })
