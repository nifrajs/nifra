<script>
  let { children } = $props()
  let opened = $state(0)
</script>

<div class="shop">
  <button type="button" class="shop-count" onclick={() => opened++}>shop {opened}</button>
  {@render children()}
</div>
