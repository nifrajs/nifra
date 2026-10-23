<script>
  import ShareRow from "./ShareRow.svelte"
  let { data } = $props()
  $effect(() => {
    void data
    globalThis.shareCounts.effects++
  })
</script>

<ul>
  {#each data.items as row (row.id)}
    <ShareRow {row} />
  {/each}
</ul>
