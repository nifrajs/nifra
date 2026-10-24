<script>
  let { data } = $props()
</script>

<section class="rows">
  <h1 id="title">List {data.id}</h1>
  <ul>
    {#each data.rows as row (row.id)}
      <li><span>{row.label}</span> <span>{row.price}</span><input type="checkbox" /></li>
    {/each}
  </ul>
</section>
