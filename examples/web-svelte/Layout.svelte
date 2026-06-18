<!-- Root layout — wraps the page via its `children` snippet (the Chain fold passes the page there). -->
<script>
  let { children } = $props()
</script>

<div class="wrap">{@render children()}</div>
