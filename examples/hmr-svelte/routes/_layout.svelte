<!-- Root layout — wraps every page via its children snippet; the nav proves client nav works. -->
<script>
  let { children } = $props()
</script>

<div>
  <nav id="nav"><a href="/">home</a> · <a href="/about">about</a></nav>
  {@render children()}
</div>
