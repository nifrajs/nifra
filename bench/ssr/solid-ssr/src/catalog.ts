export function catalogItems(): { id: number; name: string }[] {
  return Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `Item ${i + 1}`,
  }))
}
