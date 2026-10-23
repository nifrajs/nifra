import { usePageVisibility } from "@nifrajs/web-react/keep-alive"
import { useParams } from "@nifrajs/web-react/router"
import { useEffect, useId, useState } from "react"

export const keepAlive = true

type Data = { readonly id: string; readonly items: readonly { id: number; label: string }[] }
const ticks = (): Record<string, number> => {
  const held = Reflect.get(globalThis, "__ticks") as Record<string, number> | undefined
  if (held !== undefined) return held
  const fresh: Record<string, number> = {}
  Reflect.set(globalThis, "__ticks", fresh)
  return fresh
}
const LINES = Array.from({ length: 40 }, (_, i) => i)

export default function List({ data }: { readonly data: Data }) {
  const instance = useId()
  const [count, setCount] = useState(0)
  const params = useParams()
  const visible = usePageVisibility()
  useEffect(() => {
    const timer = setInterval(() => {
      const all = ticks()
      all[instance] = (all[instance] ?? 0) + 1
    }, 10)
    return () => clearInterval(timer)
  }, [instance])
  return (
    <section
      className="list-page"
      data-instance={instance}
      data-param={params.id}
      data-visible={String(visible)}
    >
      <h1 id="list-title">List {data.id}</h1>
      <button type="button" className="count" onClick={() => setCount((c) => c + 1)}>
        count {count}
      </button>
      <details className="more">
        <summary>More</summary>
        <p>Details for list {data.id}</p>
      </details>
      <input className="draft" defaultValue="" />
      <div className="inner-scroll" style={{ height: 80, overflow: "auto" }}>
        {LINES.map((i) => (
          <p key={i}>line {i}</p>
        ))}
      </div>
      <ul>
        {data.items.map((item) => (
          <li key={item.id} data-id={item.id}>
            <span>{item.label}</span>
            <input type="checkbox" />
          </li>
        ))}
      </ul>
    </section>
  )
}
