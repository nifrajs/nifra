<!--
  Slot.svelte - one node of the keep-alive tree (KeepAlive.svelte): a layout and the slots under it, or
  a page through the shipped `Chain` (its `_error` boundary, then the page).

  A wrapped node renders inside the two slot wrappers; the inner one is the element the DOM half takes
  out of the document while the node is hidden. Its page keeps running there, so a wrapped node also
  provides the routing context of its own state - a hidden page never reads another page's params - and
  its visibility, which `useBlocker` reads and the callbacks `onPageHide` / `onPageShow` register with
  (the key strings are kept in sync with router.ts).
-->
<script>
  import { setContext, untrack } from "svelte"
  import Chain from "./Chain.svelte"
  import Self from "./Slot.svelte"
  let { node, mount } = $props()

  let props = $derived(mount.propsOf(node.state))
  let data = $derived(props.data)
  let chain = $derived(mount.chainOf(node.state))
  let pageChain = $derived(chain.slice(node.depth))
  let pageLayoutData = $derived(props.layoutData?.slice(node.depth))

  // A node keeps its key, and a key its wrappers, for as long as it is mounted.
  // svelte-ignore state_referenced_locally
  if (node.wrapped) {
    setContext("@nifrajs/web-svelte:props", () => props)
    setContext("@nifrajs/web-svelte:search", () => props.search ?? {})
    const hide = new Set()
    const show = new Set()
    setContext("@nifrajs/web-svelte:visibility", { hidden: () => node.hidden, hide, show })
    // svelte-ignore state_referenced_locally
    let hidden = node.hidden
    $effect(() => {
      const now = node.hidden
      if (now === hidden) return
      hidden = now
      untrack(() => {
        for (const callback of [...(now ? hide : show)]) callback()
      })
    })
  }

  // Built once: an attachment whose expression reads `node` re-runs on every change of it, cleaning up
  // after the new one has attached, which would clear the element it just set.
  const attach = (ref) => (element) => {
    ref(element)
    return () => ref(null)
  }
  // svelte-ignore state_referenced_locally
  const attachEntry = attach(mount.entry(node.key))
  // svelte-ignore state_referenced_locally
  const attachPage = attach(mount.page(node.key))
</script>

{#snippet content()}
  {#if node.children === undefined}
    <Chain chain={pageChain} {props} {data} layoutData={pageLayoutData} />
  {:else}
    {@const Layout = chain[node.depth]}
    <Layout data={props.layoutData?.[node.depth] ?? null} boundaries={props.boundaries}>
      {#snippet children()}
        {#each node.children as child (child.key)}
          <Self node={child} {mount} />
        {/each}
      {/snippet}
    </Layout>
  {/if}
{/snippet}

{#if node.wrapped}
  <!-- A `<slot>` lays out as `display: contents`, with no inline style a CSP could block; Svelte
    keeps the tag name itself for its own slots. -->
  <svelte:element this={"slot"} data-nifra-entry {@attach attachEntry}>
    <svelte:element this={"slot"} data-nifra-page {@attach attachPage}>
      {@render content()}
    </svelte:element>
  </svelte:element>
{:else}
  {@render content()}
{/if}
