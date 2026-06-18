<!--
  A Svelte 5 route component. `data` is the loader output; the $state counter proves hydration (it's
  interactive only after the client hydrates). Svelte 5 uses native `onclick` + the `$state` rune.
-->
<script>
  let { data } = $props()
  let count = $state(data.start)
</script>

<main>
  <h1>{data.message}</h1>
  <button id="btn" type="button" onclick={() => count++}>count: {count}</button>
</main>
