/** @jsxImportSource preact */
import type { ComponentChildren } from "preact"
import { useState } from "preact/hooks"
import type { Product } from "../../shared/catalog.ts"

/** The page every variant renders: the shared product part around the three per-visitor parts. */
export function ProductPage(props: {
  readonly product: Product
  readonly children?: ComponentChildren
}) {
  const { product } = props
  return (
    <main>
      <h1>{product.name}</h1>
      <p>{product.price}</p>
      <p>{product.description}</p>
      <table>
        <tbody>
          {product.specs.map((spec) => (
            <tr key={spec.k}>
              <th>{spec.k}</th>
              <td>{spec.v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.children}
      <ul>
        {product.related.map((item) => (
          <li key={item.id}>
            <a href={`/ppr/${item.id}`}>{item.name}</a> {item.price}
          </li>
        ))}
      </ul>
    </main>
  )
}

export const Greeting = (props: { readonly name: string }) => <p>hello {props.name}</p>

export function Cart(props: { readonly count: number }) {
  const [count, setCount] = useState(props.count)
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      cart {count}
    </button>
  )
}

export const Recs = (props: { readonly items: readonly string[] }) => (
  <ul>
    {props.items.map((item) => (
      <li key={item}>{item}</li>
    ))}
  </ul>
)

export const Loading = (props: { readonly text: string }) => <p>{props.text}</p>
