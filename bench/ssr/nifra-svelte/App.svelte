<script lang="ts">
  import type { CatalogPageData } from "../shared/catalog.ts"

  let { data }: { data: CatalogPageData } = $props()
</script>

<main>
  <h1>Items ({data.items.length})</h1>
  <ul>
    {#each data.items as it (it.id)}
      <li>{it.name}</li>
    {/each}
  </ul>
</main>
