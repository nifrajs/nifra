import { For } from "solid-js"
import type { CatalogPageData } from "../shared/catalog.ts"

export function App(props: { data: CatalogPageData }) {
  return (
    <main>
      <h1>Items ({props.data.items.length})</h1>
      <ul>
        <For each={props.data.items}>{(it) => <li>{it.name}</li>}</For>
      </ul>
    </main>
  )
}
