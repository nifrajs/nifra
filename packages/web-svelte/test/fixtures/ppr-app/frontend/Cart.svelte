<script>
  let { count } = $props()
  let clicks = $state(0)
</script>

<button id="cart" type="button" onclick={() => clicks++}>cart {count + clicks}</button>

<style>
  button {
    font-weight: 700;
  }
</style>
