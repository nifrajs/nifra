import type { CatalogPageData } from "../shared/catalog.ts"

export type PageData = CatalogPageData

/** SSR bench page — identical workload across every nifra UI adapter. */
export function App(props: { data: PageData }) {
  return (
    <main>
      <h1>Items ({props.data.items.length})</h1>
      <ul>
        {props.data.items.map((it) => (
          <li key={it.id}>{it.name}</li>
        ))}
      </ul>
    </main>
  )
}
