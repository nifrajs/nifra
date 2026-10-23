import { useParams } from "@nifrajs/web-react/router"
import { useState } from "react"

export const keepAlive = true

export default function Item() {
  const [count, setCount] = useState(0)
  return (
    <article className="item">
      <h1>Item {useParams().item}</h1>
      <button type="button" className="item-count" onClick={() => setCount((c) => c + 1)}>
        item {count}
      </button>
    </article>
  )
}
