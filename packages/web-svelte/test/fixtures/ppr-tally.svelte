<!-- Shows the props it was given beside a click count only the component holds. -->
<script>
  let { count } = $props()
  let clicks = $state(0)
</script>

<button type="button" onclick={() => clicks++}>cart {count} clicked {clicks}</button>
