<!-- A style-less component: the dom build must NOT emit a ?svelte-css import (the compile yields no CSS). -->
<script>
  let { label = "plain" } = $props()
</script>

<span>{label}</span>
