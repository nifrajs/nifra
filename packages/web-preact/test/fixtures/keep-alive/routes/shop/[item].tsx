/** @jsxImportSource preact */
import { useState } from "preact/hooks"

export const keepAlive = true

export default function Item({ params }: { readonly params: Readonly<Record<string, string>> }) {
  const [count, setCount] = useState(0)
  return (
    <article className="item">
      <h1>Item {params.item}</h1>
      <button type="button" className="item-count" onClick={() => setCount((c) => c + 1)}>
        item {count}
      </button>
    </article>
  )
}
