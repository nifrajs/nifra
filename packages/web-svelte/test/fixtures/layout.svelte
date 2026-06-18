<script>
  let { children } = $props()
</script>

<section data-layout="outer">
  <span>layout shell</span>
  {@render children()}
</section>
