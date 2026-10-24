<!--
  KeepAlive.svelte - the root of an app with a `keepAlive` route, on the server and in the browser
  alike, so the hydration markers of the two renders match. It renders the page on screen and every
  kept page as a tree of slots (`slotTree` from `@nifrajs/web/keep-alive`), grouped by the layouts they
  share, each slot through `Slot.svelte`.

  In the browser `router` is the store: the root follows its snapshot, recomputes the tree keeping every
  node that did not change, and hands each committed tree to the DOM half (`mount.after`), which parks
  hidden slots and restores the ones shown again. On the server `tree` is the one page the document
  renders, and nothing subscribes.
-->
<script>
  import { setContext } from "svelte"
  import Slot from "./Slot.svelte"
  let { router, initial, tree: fixed, mount } = $props()

  // The router never changes identity for this component's lifetime: the subscription carries the
  // reactivity, as in Router.svelte. `raw`: a snapshot is replaced, never mutated.
  // svelte-ignore state_referenced_locally
  let snapshot = $state.raw(router === undefined ? initial : router.snapshot())
  $effect(() => router?.subscribe(() => { snapshot = router.snapshot() }))
  let previous
  let tree = $derived.by(() => {
    const next = fixed ?? mount.tree(snapshot, previous)
    previous = next
    return next
  })
  let props = $derived(mount.propsOf(snapshot))

  // What the routing reads of the page on screen; a kept slot provides its own (Slot.svelte). The key
  // strings are kept in sync with router.ts.
  setContext("@nifrajs/web-svelte:props", () => props)
  setContext("@nifrajs/web-svelte:search", () => props.search ?? {})

  $effect(() => {
    mount.after(tree)
  })
</script>

{#each tree as node (node.key)}
  <Slot {node} {mount} />
{/each}
