<script lang="ts" module>
  export const meta = { title: "nifra SSR bench (Svelte)" }
</script>

<script lang="ts">
  import type { LoaderData } from "@nifrajs/client"
  import type { loader } from "./index.backend"

  let { data }: { data: LoaderData<typeof loader> } = $props()
</script>

<main>
  <h1>Items ({data.items.length})</h1>
  <ul>
    {#each data.items as it (it.id)}
      <li>{it.name}</li>
    {/each}
  </ul>
</main>
