import { t } from "@nifrajs/schema"

export const loaderOutput = t.object({
  id: t.string(),
  items: t.array(t.object({ id: t.number(), label: t.string() })),
})

export const loader = ({ params }: { readonly params: Readonly<Record<string, string>> }) => ({
  id: params.id ?? "",
  items: Array.from({ length: 50 }, (_, i) => ({ id: i, label: `row ${i}` })),
})
