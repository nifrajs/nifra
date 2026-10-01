<script lang="ts" module>
  export const meta = { title: "nifra SSR bench (Svelte SSG)" }
</script>

<script lang="ts">
  import App from "../../nifra-svelte/App.svelte"
  import type { LoaderData } from "@nifrajs/client"

  let { data }: { data: LoaderData<typeof loader> } = $props()
</script>

<App {data} />
