// Forced per-request SSR (not SSG/ISR) — the loader runs every request, the identical
// 50-item workload as every other framework.
export const dynamic = "force-dynamic"

async function load() {
  return Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` }))
}

export default async function Page() {
  const items = await load()
  return (
    <main>
      <h1>Items ({items.length})</h1>
      <ul>
        {items.map((it) => (
          <li key={it.id}>{it.name}</li>
        ))}
      </ul>
    </main>
  )
}
