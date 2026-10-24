import { createSignal } from "solid-js"

export const keepAlive = true

export default function Item(props: { readonly params: Readonly<Record<string, string>> }) {
  const [count, setCount] = createSignal(0)
  return (
    <article class="item">
      <h1>Item {props.params.item}</h1>
      <button type="button" class="item-count" onClick={() => setCount((c) => c + 1)}>
        item {count()}
      </button>
    </article>
  )
}
