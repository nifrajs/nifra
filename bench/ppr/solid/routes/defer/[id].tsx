/** @jsxImportSource solid-js */
import type { Deferred } from "@nifrajs/web"
import { Await } from "@nifrajs/web-solid/await"
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
  return (
    <ProductPage product={props.data.product}>
      <Await resolve={props.data.greeting} fallback={<Loading text="loading greeting" />}>
        {(value) => <Greeting name={value.name} />}
      </Await>
      <Await resolve={props.data.cart} fallback={<Loading text="loading cart" />}>
        {(value) => <Cart count={value.count} />}
      </Await>
      <Await resolve={props.data.recs} fallback={<Loading text="loading recommendations" />}>
        {(value) => <Recs items={value.items} />}
      </Await>
    </ProductPage>
  )
}
