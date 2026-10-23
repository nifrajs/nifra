<script>
  let { count } = $props()
  let clicks = $state(0)
</script>

<button type="button" onclick={() => clicks++}>cart {count + clicks}</button>
