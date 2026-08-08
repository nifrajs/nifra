<!--
  Component-only `.svelte` → a Svelte HMR boundary. Editing this file hot-swaps it in place, with no
  page reload and the rest of the app left standing - keep a route's view here; the route file (which
  exports loader/meta in `<script module>`) full-reloads on save.

  The `$state` count itself resets to 0 on a hot-swap. That is Svelte's own HMR: the wrapper resolves
  the component through a signal, so a new version destroys the old branch and creates a fresh one.
  Frameworks whose HMR keeps component state (React, Vue, Solid) do preserve it in the sibling examples.
-->
<script>
  let { message } = $props()
  let count = $state(0)
</script>

<div>
  <h1 id="page">nifra + Vite - true HMR (Svelte)</h1>
  <p id="ssr">{message}</p>
  <p id="count">count: {count}</p>
  <button id="inc" type="button" onclick={() => count++}>increment</button>
</div>
