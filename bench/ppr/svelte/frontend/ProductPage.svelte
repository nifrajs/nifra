<!-- The page every variant renders: the shared product part around the three per-visitor parts. -->
<script>
  let { product, children } = $props()
</script>

<main>
  <h1>{product.name}</h1>
  <p>{product.price}</p>
  <p>{product.description}</p>
  <table>
    <tbody>
      {#each product.specs as spec (spec.k)}
        <tr><th>{spec.k}</th><td>{spec.v}</td></tr>
      {/each}
    </tbody>
  </table>
  {@render children?.()}
  <ul>
    {#each product.related as item (item.id)}
      <li><a href={`/ppr/${item.id}`}>{item.name}</a> {item.price}</li>
    {/each}
  </ul>
</main>
