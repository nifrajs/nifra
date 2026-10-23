/** @jsxImportSource solid-js */
import { createSignal, For, type JSX } from "solid-js"
import type { Product } from "../../shared/catalog.ts"

/** The page every variant renders: the shared product part around the three per-visitor parts. */
export function ProductPage(props: { readonly product: Product; readonly children?: JSX.Element }) {
  return (
    <main>
      <h1>{props.product.name}</h1>
      <p>{props.product.price}</p>
      <p>{props.product.description}</p>
      <table>
        <tbody>
          <For each={props.product.specs}>
            {(spec) => (
              <tr>
                <th>{spec.k}</th>
                <td>{spec.v}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      {props.children}
      <ul>
        <For each={props.product.related}>
          {(item) => (
            <li>
              <a href={`/ppr/${item.id}`}>{item.name}</a> {item.price}
            </li>
          )}
        </For>
      </ul>
    </main>
  )
}

export const Greeting = (props: { readonly name: string }) => <p>hello {props.name}</p>

export function Cart(props: { readonly count: number }) {
  const [count, setCount] = createSignal(props.count)
  return (
    <button type="button" onClick={() => setCount(count() + 1)}>
      cart {count()}
    </button>
  )
}

export const Recs = (props: { readonly items: readonly string[] }) => (
  <ul>
    <For each={props.items}>{(item) => <li>{item}</li>}</For>
  </ul>
)

export const Loading = (props: { readonly text: string }) => <p>{props.text}</p>
