<script>
  let { data, children } = $props()
</script>

<section data-from={data?.from ?? "none"}>{@render children()}</section>
