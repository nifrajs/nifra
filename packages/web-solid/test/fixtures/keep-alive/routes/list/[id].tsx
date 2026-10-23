import { onPageHide, onPageShow, usePageVisibility } from "@nifrajs/web-solid/router"
import { createSignal, createUniqueId, For, onCleanup, onMount } from "solid-js"

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

export default function List(props: {
  readonly data: Data
  readonly params: Readonly<Record<string, string>>
}) {
  const instance = createUniqueId()
  const [count, setCount] = createSignal(0)
  const visible = usePageVisibility()
  let timer: ReturnType<typeof setInterval> | undefined
  const start = () => {
    timer = setInterval(() => {
      const all = ticks()
      all[instance] = (all[instance] ?? 0) + 1
    }, 10)
  }
  onMount(start)
  onCleanup(() => clearInterval(timer))
  onPageHide(() => clearInterval(timer))
  onPageShow(start)
  return (
    <section
      class="list-page"
      data-instance={instance}
      data-param={props.params.id}
      data-visible={String(visible())}
    >
      <h1 id="list-title">List {props.data.id}</h1>
      <button type="button" class="count" onClick={() => setCount((c) => c + 1)}>
        count {count()}
      </button>
      <details class="more">
        <summary>More</summary>
        <p>Details for list {props.data.id}</p>
      </details>
      <input class="draft" value="" />
      <div class="inner-scroll" style={{ height: "80px", overflow: "auto" }}>
        <For each={LINES}>{(i) => <p>line {i}</p>}</For>
      </div>
      <ul>
        <For each={props.data.items}>
          {(item) => (
            <li data-id={item.id}>
              <span>{item.label}</span>
              <input type="checkbox" />
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}
