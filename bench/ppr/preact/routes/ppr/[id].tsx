/** @jsxImportSource preact */
import type { BoundaryStates } from "@nifrajs/web"
import { Hole } from "@nifrajs/web-preact/ppr"
import type { Product } from "../../../shared/catalog.ts"
import { Cart, Greeting, Loading, ProductPage, Recs } from "../../frontend/product.tsx"

const greeting = {
  name: "greeting",
  mode: "dynamic" as const,
  render: (data: { readonly name: string }) => <Greeting name={data.name} />,
  fallback: <Loading text="loading greeting" />,
}
const cart = {
  name: "cart",
  mode: "dynamic" as const,
  interactive: true,
  render: (data: { readonly count: number }) => <Cart count={data.count} />,
  fallback: <Loading text="loading cart" />,
}
const recs = {
  name: "recs",
  mode: "dynamic" as const,
  render: (data: { readonly items: readonly string[] }) => <Recs items={data.items} />,
  fallback: <Loading text="loading recommendations" />,
}
export const boundaries = [greeting, cart, recs]

export default function PprProduct(props: {
  readonly data: { readonly product: Product }
  readonly boundaries?: BoundaryStates
}) {
  return (
    <ProductPage product={props.data.product}>
      <Hole of={greeting} state={props.boundaries?.greeting} />
      <Hole of={cart} state={props.boundaries?.cart} />
      <Hole of={recs} state={props.boundaries?.recs} />
    </ProductPage>
  )
}
