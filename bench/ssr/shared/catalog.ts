/** Shared SSR bench catalog — identical 50-item payload for every framework row. */
export interface CatalogItem {
  readonly id: number
  readonly name: string
}

export interface CatalogPageData {
  readonly items: ReadonlyArray<CatalogItem>
}

export function catalogItems(): CatalogPageData["items"] {
  return Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `Item ${i + 1}`,
  }))
}
