/** @jsxImportSource preact */
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
  const { data } = props
  return (
    <ProductPage product={data.product}>
      <Greeting name={data.greeting.name} />
      <Cart count={data.cart.count} />
      <Recs items={data.recs.items} />
    </ProductPage>
  )
}
