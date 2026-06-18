<!--
  Router.svelte — the reactive root for client navigation. Holds the agnostic store's snapshot in
  `$state`, subscribes via `$effect` (cleaned up on unmount), and renders the matched layout chain
  through `Chain.svelte`. `$derived` recomputes the chain + props on every store change, so client
  navigations swap routes without a full reload. The initial snapshot matches the SSR markup (the
  server rendered `Chain` for the same matched route), so `hydrate` reconciles cleanly.

  Runes (`$state`/`$effect`/`$derived`) only work in compiled `.svelte` files — which is why this
  reactive root is a component, not a function in `client.ts`.
-->
<script>
  import Chain from "./Chain.svelte"
  let { router, routes } = $props()

  let snapshot = $state(router.snapshot())
  $effect(() => router.subscribe(() => { snapshot = router.snapshot() }))

  let chain = $derived(routes[snapshot.routeId] ?? [])
  let props = $derived({
    data: snapshot.data,
    actionData: snapshot.actionData,
    pending: snapshot.pending,
    ...(snapshot.submission ? { submission: snapshot.submission } : {}),
  })
</script>

<Chain {chain} {props} />
