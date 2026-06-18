<script lang="ts" module>
  import { catalogItems, type CatalogPageData } from "../../shared/catalog.ts"

  export const meta = { title: "nifra SSR bench (Svelte SSG)" }
  export const prerender = true

  export function loader(): CatalogPageData {
    return { items: catalogItems() }
  }
</script>

<script lang="ts">
  import App from "../../nifra-svelte/App.svelte"
  import type { LoaderData } from "@nifrajs/client"

  let { data }: { data: LoaderData<typeof loader> } = $props()
</script>

<App {data} />
