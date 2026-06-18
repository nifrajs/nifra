// Build-time static catalog — the same 50 items as the dynamic SSR bench. Next pre-renders this at
// `next build`; steady-state requests serve the cached HTML (Next's best-case path for fixed content).
const ITEMS = Array.from({ length: 50 }, (_, i) => ({
  id: i + 1,
  name: `Item ${i + 1}`,
}))

export default function Page() {
  return (
    <main>
      <h1>Items ({ITEMS.length})</h1>
      <ul>
        {ITEMS.map((it) => (
          <li key={it.id}>{it.name}</li>
        ))}
      </ul>
    </main>
  )
}
