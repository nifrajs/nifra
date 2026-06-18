import type { LoaderData } from "@nifrajs/client"
import { App, type PageData } from "../../nifra/app.tsx"

export const meta = { title: "nifra SSR bench (ISR)" }

// Long TTL so the oha window stays on cache hits after the runner's warmup (paired with next ISR).
export const revalidate = 3600

export function loader(): PageData {
  return {
    items: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` })),
  }
}

export default function Index(props: { data: LoaderData<typeof loader> }) {
  return <App data={props.data} />
}
