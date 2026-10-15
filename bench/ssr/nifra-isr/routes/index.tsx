import type { LoaderData } from "@nifrajs/client"
import type { loader } from "./index.backend.ts"

export const meta = { title: "nifra SSR bench (React ISR)" }

export default function Index({ data }: { data: LoaderData<typeof loader> }) {
  return (
    <main>
      <h1>Items ({data.items.length})</h1>
      <ul>
        {data.items.map((it) => (
          <li key={it.id}>{it.name}</li>
        ))}
      </ul>
    </main>
  )
}
