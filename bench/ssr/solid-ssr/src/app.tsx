import { For } from "solid-js"

export function Page(props: { items: { id: number; name: string }[] }) {
  return (
    <main>
      <h1>Items ({props.items.length})</h1>
      <ul>
        <For each={props.items}>{(it) => <li>{it.name}</li>}</For>
      </ul>
    </main>
  )
}
