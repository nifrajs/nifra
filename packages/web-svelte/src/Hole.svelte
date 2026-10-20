<!--
  Hole.svelte - experimental: one `dynamic` boundary of a partially prerendered page.

  In a shared shell the hole is an empty host Svelte never fills or diffs: the PPR runtime puts the
  server's HTML into it, and an interactive hole then hydrates as its own root from the frame's props.
  After a client navigation the hole renders like any streamed boundary. `of.render` and `of.fallback`
  are `ui(Component, props)` values. Plain JS, like Await.svelte.
-->
<script>
  import { hydrate, unmount } from "svelte"
  import Await from "./Await.svelte"

  let { of, state, error: failed } = $props()

  // An action, so it runs once the host is in the document, whichever of hydration and the fill
  // comes first. The runtime is the shell's inline script (internal/ppr/runtime.ts in @nifrajs/web).
  const hydrateFill = (host) => {
    const runtime = globalThis.__nifraPpr
    if (of.interactive !== true || typeof runtime !== "function" || runtime.get === undefined) return
    const name = of.name
    let root
    const fill = (frame) => {
      if (frame.error || root !== undefined) return
      const view = of.render(frame.props)
      root = hydrate(view.component, { target: host, props: view.props })
    }
    const now = runtime.get(name)
    const unsubscribe = now === undefined ? runtime.subscribe(name, fill) : undefined
    if (now !== undefined) fill(now)
    return {
      destroy() {
        unsubscribe?.()
        if (root !== undefined) unmount(root)
      },
    }
  }
</script>

{#snippet view(ui)}
  {#if ui}<ui.component {...ui.props} />{/if}
{/snippet}

{#if state?.ppr === true}
  <div use:hydrateFill data-nifra-hole={of.name} aria-busy="true"></div>
{:else if state === undefined}
  {@render view(of.fallback)}
{:else if state.status === "error"}
  {@render failed?.()}
{:else if state.status === "ready"}
  {@render view(of.render(state.data))}
{:else if state.data === undefined}
  <!-- A streamed hole's data is its deferred loader output, whatever status the payload names. -->
  {@render view(of.fallback)}
{:else}
  <Await resolve={state.data}>
    {#snippet pending()}{@render view(of.fallback)}{/snippet}
    {#snippet children(value)}{@render view(of.render(value))}{/snippet}
    {#snippet error()}{@render failed?.()}{/snippet}
  </Await>
{/if}
