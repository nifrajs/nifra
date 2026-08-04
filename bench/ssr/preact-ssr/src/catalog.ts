export interface CatalogItem {
  readonly id: number
  readonly name: string
}

export function catalogItems(): CatalogItem[] {
  return Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `Item ${i + 1}`,
  }))
}
