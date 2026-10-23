<script module>
  export const keepAlive = true
</script>

<script>
  let { params } = $props()
  let count = $state(0)
</script>

<article class="item">
  <h1>Item {params.item}</h1>
  <button type="button" class="item-count" onclick={() => count++}>item {count}</button>
</article>
