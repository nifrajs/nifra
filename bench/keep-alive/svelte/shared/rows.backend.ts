import { t } from "@nifrajs/schema"

export const loaderOutput = t.object({
  id: t.string(),
  rows: t.array(t.object({ id: t.number(), label: t.string(), price: t.string() })),
})

// 1,000 rows, about 6,200 nodes once rendered.
export const loader = ({ params }: { readonly params: Readonly<Record<string, string>> }) => ({
  id: params.id ?? "",
  rows: Array.from({ length: 1000 }, (_, i) => ({
    id: i,
    label: `Row ${i}`,
    price: (i * 1.37).toFixed(2),
  })),
})
