// ISR — same 50-item loader as the dynamic bench, but Next caches the rendered page between
// revalidations. The runner warms the cache before oha so this row reflects steady-state ISR hits.
export const revalidate = 3600

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
