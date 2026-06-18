import type { Route } from "./+types/home"

// Loader runs per request (SSR) — the identical 50-item workload.
export function loader() {
  return { items: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` })) }
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>Items ({loaderData.items.length})</h1>
      <ul>
        {loaderData.items.map((it) => (
          <li key={it.id}>{it.name}</li>
        ))}
      </ul>
    </main>
  )
}
