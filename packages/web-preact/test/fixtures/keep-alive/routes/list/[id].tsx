/** @jsxImportSource preact */
import { onPageHide, onPageShow, usePageVisibility } from "@nifrajs/web-preact/router"
import { useEffect, useId, useRef, useState } from "preact/hooks"

export const keepAlive = true

type Data = { readonly id: string; readonly items: readonly { id: number; label: string }[] }
const ticks = (): Record<string, number> => {
  const held: Record<string, number> | undefined = Reflect.get(globalThis, "__ticks")
  if (held !== undefined) return held
  const fresh: Record<string, number> = {}
  Reflect.set(globalThis, "__ticks", fresh)
  return fresh
}
const LINES = Array.from({ length: 40 }, (_, i) => i)

export default function List({
  data,
  params,
}: {
  readonly data: Data
  readonly params: Readonly<Record<string, string>>
}) {
  const instance = useId()
  const [count, setCount] = useState(0)
  const visible = usePageVisibility()
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const start = () => {
    timer.current = setInterval(() => {
      const all = ticks()
      all[instance] = (all[instance] ?? 0) + 1
    }, 10)
  }
  useEffect(() => {
    start()
    return () => clearInterval(timer.current)
  }, [])
  onPageHide(() => clearInterval(timer.current))
  onPageShow(start)
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
