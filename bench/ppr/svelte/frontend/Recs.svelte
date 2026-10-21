<script>
  let { items } = $props()
</script>

<ul>
  {#each items as item (item)}
    <li>{item}</li>
  {/each}
</ul>
