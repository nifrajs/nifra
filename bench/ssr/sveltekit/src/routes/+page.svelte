<script lang="ts">
  let { data } = $props()
</script>

<main>
  <h1>Items ({data.items.length})</h1>
  <ul>
    {#each data.items as it (it.id)}
      <li>{it.name}</li>
    {/each}
  </ul>
</main>
