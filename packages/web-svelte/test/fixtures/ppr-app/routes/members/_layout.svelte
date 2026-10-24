<script>
  let { data, children } = $props()
</script>

<section id="members" data-member={data?.member === undefined ? "no" : "yes"}>
  {@render children?.()}
</section>
