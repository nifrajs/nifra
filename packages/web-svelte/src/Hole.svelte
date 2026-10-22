<!--
  Hole.svelte - experimental: one `dynamic` or `shared` boundary of a partially prerendered page.

  In a shared shell the hole is an empty host Svelte never fills or diffs: the PPR runtime puts the
  server's HTML into it, and an interactive hole then hydrates as its own root from the frame's props.
  When the page reloads, after an action or a live change, the host takes the new fill in place: an
  interactive root gets the new props and keeps its state, unless the render picks another component.
  After a client navigation the hole renders like any streamed boundary. `of.render` and `of.fallback`
  are `ui(Component, props)` values. Plain JS, like Await.svelte.
-->
<script>
  import { holeHost } from "@nifrajs/web/internal/hole-runtime"
  import { hydrate, unmount } from "svelte"
  import Await from "./Await.svelte"

  // Aliased: a binding named `state` would make `$state` read as that store's value.
  let { of, state: shown, error: failed } = $props()

  /** An interactive hole's own root: a refill writes the new props into its state proxy. */
  const hydrateRoot = (target, data) => {
    const first = of.render(data)
    const props = $state({ ...first.props })
    const root = hydrate(first.component, { target, props })
    return {
      update(next) {
        const view = of.render(next)
        if (view.component !== first.component) return false
        for (const key of Object.keys(props)) if (!Object.hasOwn(view.props, key)) delete props[key]
        Object.assign(props, view.props)
        return true
      },
      dispose() {
        unmount(root)
      },
    }
  }

  // An action, so it runs once the host is in the document, whichever of hydration and the fill
  // comes first; a refill reaches it as the action's new parameter.
  const hostHole = (host, fill) => {
    const driven = holeHost(of.name, host, of.interactive === true ? hydrateRoot : undefined)
    if (fill !== undefined) driven?.refill(fill)
    return {
      update(next) {
        if (next !== undefined) driven?.refill(next)
      },
      destroy() {
        driven?.dispose()
      },
    }
  }
</script>

{#snippet view(ui)}
  {#if ui}<ui.component {...ui.props} />{/if}
{/snippet}

{#if shown?.ppr === true}
  <div use:hostHole={shown.fill} data-nifra-hole={of.name} aria-busy="true"></div>
{:else if shown === undefined}
  {@render view(of.fallback)}
{:else if shown.status === "error"}
  {@render failed?.()}
{:else if shown.status === "ready"}
  {@render view(of.render(shown.data))}
{:else if shown.data === undefined}
  <!-- A streamed hole's data is its deferred loader output, whatever status the payload names. -->
  {@render view(of.fallback)}
{:else}
  <Await resolve={shown.data}>
    {#snippet pending()}{@render view(of.fallback)}{/snippet}
    {#snippet children(value)}{@render view(of.render(value))}{/snippet}
    {#snippet error()}{@render failed?.()}{/snippet}
  </Await>
{/if}
