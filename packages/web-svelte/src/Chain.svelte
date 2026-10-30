<!--
  Chain.svelte - folds a nifra layout chain (outermost layout → page) into nested Svelte components:
  the page (innermost, chain[last]) receives `props` (the loader data); each layout wraps the rest via
  its `children` snippet ({@render children()} in the layout). Recurses on itself. This is the Svelte
  analogue of the React/Vue `compose` - Svelte components are compiled (not callable), so the fold is a
  component, not a function returning a node.

  `data` is the page's loader data, passed apart from `props` so that the page reads it through the
  Router's identity-checked `$derived`: an effect on it re-runs only when a reload changed it.

  `layoutData` is the per-layout loader data, aligned with the chain's LEADING layout prefix. It is
  sliced in lockstep with `chain` as each layout is consumed, so a layout always reads its own entry.
  The `_error` boundary marker deliberately does NOT consume from it: the marker sits after every
  layout, so the array is already empty by then, and leaving it alone keeps that true if it ever moves.
-->
<script>
  import { hasContext, setContext } from "svelte"
  import Self from "./Chain.svelte"
  let { chain, props, data, layoutData, replaceContext = false } = $props()
  // Provide the validated search as a getter (so `useSearch` reads the current value reactively) - the
  // same value the server put in RenderProps.search, so a query-reading page hydrates with no drift. The
  // key string is kept in sync with router.ts's `useSearch`.
  setContext("@nifrajs/web-svelte:search", () => props.search ?? {})
  // The props `useMatches` reads, provided once by the outermost Chain, where `layoutData` is still
  // whole (each nested Chain holds only its own tail). The key string is kept in sync with router.ts.
  if (replaceContext || !hasContext("@nifrajs/web-svelte:props")) {
    setContext("@nifrajs/web-svelte:props", () => ({ ...props, data, layoutData }))
  }
</script>

{#if chain.length <= 1}
  {#if chain[0]}
    {@const Page = chain[0]}
    <Page {...props} {data} />
  {/if}
{:else if chain[0] && chain[0].__nifraErrorBoundary}
  <!-- nifra `_error` boundary marker (from errorBoundary()): wrap the rest in <svelte:boundary>; the
       `failed` snippet renders the route's _error component with the serialized error. -->
  {@const Fallback = chain[0].__nifraErrorBoundary}
  <svelte:boundary>
      <Self chain={chain.slice(1)} {props} {data} {layoutData} {replaceContext} />
    {#snippet failed(error)}
      <Fallback data={{ name: error?.name ?? "Error", message: String(error?.message ?? error) }} />
    {/snippet}
  </svelte:boundary>
{:else}
  {@const Layout = chain[0]}
  <Layout data={layoutData?.[0] ?? null} boundaries={props.boundaries}>
    {#snippet children()}
      <Self chain={chain.slice(1)} {props} {data} layoutData={layoutData?.slice(1)} {replaceContext} />
    {/snippet}
  </Layout>
{/if}
