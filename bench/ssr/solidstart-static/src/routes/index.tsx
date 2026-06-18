import { catalogItems } from "~/lib/catalog"

const items = catalogItems()

export default function Home() {
  return (
    <main>
      <h1>Items ({items.length})</h1>
      <ul>
        {items.map((it) => (
          <li>{it.name}</li>
        ))}
      </ul>
    </main>
  )
}
