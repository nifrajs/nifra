<!--
  Router.svelte - the reactive root for client navigation. Holds the agnostic store's snapshot in
  `$state`, subscribes via `$effect` (cleaned up on unmount), and renders the matched layout chain
  through `Chain.svelte`. `$derived` recomputes the chain + props on every store change, so client
  navigations swap routes without a full reload. The initial snapshot matches the SSR markup (the
  server rendered `Chain` for the same matched route), so `hydrate` reconciles cleanly.

  Runes (`$state`/`$effect`/`$derived`) only work in compiled `.svelte` files - which is why this
  reactive root is a component, not a function in `client.ts`.
-->
<script>
  // `/client`, not the package root: the root's module graph reaches server-only code (the public-dir
  // reader and friends), and a bundler that externalizes node builtins for the browser turns that into
  // a runtime `Module "node:fs/promises" has been externalized` on the first import. `/client` is the
  // browser-safe half, and it is where every other adapter takes this from.
  import { searchOfChain } from "@nifrajs/web/client"
  import Chain from "./Chain.svelte"
  let { router, routes, searchSchemas } = $props()

  // Capturing the INITIAL `router` is the intent, not an oversight: one router instance is created
  // once per page and mounted here, so it never changes identity for this component's lifetime, and
  // the reactivity that matters is the subscription below - the store pushes, this does not re-read.
  // Wrapping it in a `$derived` would re-run `snapshot()` and hand `$state` a fresh object on every
  // change, discarding the very state the subscription is maintaining.
  // svelte-ignore state_referenced_locally
  let snapshot = $state(router.snapshot())
  $effect(() => router.subscribe(() => { snapshot = router.snapshot() }))

  let chain = $derived(routes[snapshot.routeId] ?? [])
  let props = $derived.by(() => {
    // This route's typed search from the URL + schema chain (the SAME searchOfChain the server ran), so
    // useSearch stays reactive across navigation and matches the SSR value on hydration.
    const q = snapshot.path.indexOf("?")
    return {
      data: snapshot.data,
      actionData: snapshot.actionData,
      pending: snapshot.pending,
      search: searchOfChain(searchSchemas?.[snapshot.routeId] ?? [], q === -1 ? "" : snapshot.path.slice(q)),
      ...(snapshot.submission ? { submission: snapshot.submission } : {}),
      ...(snapshot.boundaries !== undefined ? { boundaries: snapshot.boundaries } : {}),
    }
  })
</script>

<Chain {chain} {props} />
