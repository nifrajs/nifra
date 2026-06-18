<!--
  Component-only `.svelte` → a Svelte HMR boundary. Editing this file hot-swaps it with the `$state`
  count preserved (no reload) — keep a route's view here; the route file (which exports loader/meta in
  `<script module>`) full-reloads on save.
-->
<script>
  let { message } = $props()
  let count = $state(0)
</script>

<div>
  <h1 id="page">nifra + Vite — true HMR (Svelte)</h1>
  <p id="ssr">{message}</p>
  <p id="count">count: {count}</p>
  <button id="inc" type="button" onclick={() => count++}>increment</button>
</div>
