<script>
  let { children } = $props()
</script>

<div>
  <nav>
    <a href="/away">away</a> <a href="/light">light</a>
    {#each ["list", "plain", "fresh"] as route}
      {#each [1, 2, 3] as n}
        <a href={`/${route}/${n}`}>{route} {n}</a>
      {/each}
    {/each}
  </nav>
  <main>{@render children()}</main>
</div>
