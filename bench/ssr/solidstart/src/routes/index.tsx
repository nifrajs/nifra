import { For } from "solid-js"
import { catalogItems } from "~/lib/catalog"

/** Per-request catalog (SSR) — same 50-item workload as other bench apps. */
export default function Home() {
  const items = catalogItems()
  return (
    <main>
      <h1>Items ({items.length})</h1>
      <ul>
        <For each={items}>{(it) => <li>{it.name}</li>}</For>
      </ul>
    </main>
  )
}
