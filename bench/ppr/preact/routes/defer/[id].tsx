/** @jsxImportSource preact */
import type { Deferred } from "@nifrajs/web"
import { Await } from "@nifrajs/web-preact/await"
import type { Product } from "../../../shared/catalog.ts"
import { Cart, Greeting, Loading, ProductPage, Recs } from "../../frontend/product.tsx"

export default function DeferredProduct(props: {
  readonly data: {
    readonly product: Product
    readonly greeting: Deferred<{ readonly name: string }>
    readonly cart: Deferred<{ readonly count: number }>
    readonly recs: Deferred<{ readonly items: readonly string[] }>
  }
}) {
  const { data } = props
  return (
    <ProductPage product={data.product}>
      <Await resolve={data.greeting} fallback={<Loading text="loading greeting" />}>
        {(value) => <Greeting name={value.name} />}
      </Await>
      <Await resolve={data.cart} fallback={<Loading text="loading cart" />}>
        {(value) => <Cart count={value.count} />}
      </Await>
      <Await resolve={data.recs} fallback={<Loading text="loading recommendations" />}>
        {(value) => <Recs items={value.items} />}
      </Await>
    </ProductPage>
  )
}
