<!--
  Await.svelte — the `<Await>` primitive for deferred loader/action data (`defer()`), built on Svelte's
  native `{#await}` block + scoped-snippet props: `children(value)` (resolved), `pending`, `error(err)`.

  Svelte SSR renders the PENDING branch of `{#await}` (it does not block on the promise), so the server
  emits the fallback and the client resolves it (hydration / soft-nav) — matching nifra's non-blocking
  `defer()` (like the Vue adapter; contrast React/Preact, which stream the resolved content into the SSR
  HTML). An already-resolved `resolve` (a plain value, or a client nav that awaited it) renders directly.
  Plain-JS script (no TS) so it needs no svelte TS preprocessor.
-->
<script>
  let { resolve, children, pending, error } = $props()
  const isDeferred = (v) =>
    v != null && typeof v === "object" && v.__velo_deferred === true
</script>

{#if isDeferred(resolve)}
  {#await resolve.promise}
    {@render pending?.()}
  {:then value}
    {@render children?.(value)}
  {:catch err}
    {@render error?.(err)}
  {/await}
{:else}
  {@render children?.(resolve)}
{/if}
