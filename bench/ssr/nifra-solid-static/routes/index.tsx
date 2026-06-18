import type { LoaderData } from "@nifrajs/client"
import { App } from "../../nifra-solid/app.tsx"
import { type CatalogPageData, catalogItems } from "../../shared/catalog.ts"

export const meta = { title: "nifra SSR bench (Solid SSG)" }
export const prerender = true

export function loader(): CatalogPageData {
  return { items: catalogItems() }
}

export default function Index(props: { data: LoaderData<typeof loader> }) {
  return <App data={props.data} />
}
