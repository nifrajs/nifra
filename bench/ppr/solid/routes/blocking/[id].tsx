/** @jsxImportSource solid-js */
import type { Product } from "../../../shared/catalog.ts"
import { Cart, Greeting, ProductPage, Recs } from "../../frontend/product.tsx"

export default function BlockingProduct(props: {
  readonly data: {
    readonly product: Product
    readonly greeting: { readonly name: string }
    readonly cart: { readonly count: number }
    readonly recs: { readonly items: readonly string[] }
  }
}) {
  return (
    <ProductPage product={props.data.product}>
      <Greeting name={props.data.greeting.name} />
      <Cart count={props.data.cart.count} />
      <Recs items={props.data.recs.items} />
    </ProductPage>
  )
}
