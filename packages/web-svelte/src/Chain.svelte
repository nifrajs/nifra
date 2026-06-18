<!--
  Chain.svelte — folds a nifra layout chain (outermost layout → page) into nested Svelte components:
  the page (innermost, chain[last]) receives `props` (the loader data); each layout wraps the rest via
  its `children` snippet ({@render children()} in the layout). Recurses on itself. This is the Svelte
  analogue of the React/Vue `compose` — Svelte components are compiled (not callable), so the fold is a
  component, not a function returning a node.
-->
<script>
  import Self from "./Chain.svelte"
  let { chain, props } = $props()
</script>

{#if chain.length <= 1}
  {#if chain[0]}
    {@const Page = chain[0]}
    <Page {...props} />
  {/if}
{:else if chain[0] && chain[0].__veloErrorBoundary}
  <!-- nifra `_error` boundary marker (from errorBoundary()): wrap the rest in <svelte:boundary>; the
       `failed` snippet renders the route's _error component with the serialized error. -->
  {@const Fallback = chain[0].__veloErrorBoundary}
  <svelte:boundary>
    <Self chain={chain.slice(1)} {props} />
    {#snippet failed(error)}
      <Fallback data={{ name: error?.name ?? "Error", message: String(error?.message ?? error) }} />
    {/snippet}
  </svelte:boundary>
{:else}
  {@const Layout = chain[0]}
  <Layout>
    {#snippet children()}
      <Self chain={chain.slice(1)} {props} />
    {/snippet}
  </Layout>
{/if}
