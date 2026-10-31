<script lang="ts">
  import type { RenderProps, RouteSlotName } from "@nifrajs/web"
  import type { RouteSlotSnapshot } from "@nifrajs/web/client"
  import type { Snippet } from "svelte"
  import {
    getRouteSlotStore,
    routeSlotSyncKey,
    routeSlotTargetFromPath,
    stripRouteSlots,
    syncRouteSlotStore,
  } from "@nifrajs/web/client"
  import { getContext } from "svelte"
  import Chain from "./Chain.svelte"

  type Props = {
    name: RouteSlotName
    children?: Snippet
    error?: Snippet<[code: string]>
  }

  let { name, children, error } = $props<Props>()
  const readProps = getContext<(() => RenderProps) | undefined>("@nifrajs/web-svelte:props")
  let path = $derived(readProps?.().path ?? "/")
  let pending = $derived(readProps?.().pending === true)
  let basePath = $derived(stripRouteSlots(path))
  let parsed = $derived(routeSlotTargetFromPath(path, name))
  let store = $derived(getRouteSlotStore(basePath, name))
  let requestKey = $derived(
    routeSlotSyncKey(basePath, name, parsed.target, parsed.error, pending),
  )
  let snapshot = $state<RouteSlotSnapshot>(store.getServerSnapshot())

  $effect(() => {
    const currentStore = store
    if (typeof window === "undefined") {
      snapshot = currentStore.getServerSnapshot()
      return
    }
    snapshot = currentStore.getSnapshot()
    const unsubscribe = currentStore.subscribe(() => {
      snapshot = currentStore.getSnapshot()
    })
    return unsubscribe
  })

  $effect(() => {
    if (typeof window === "undefined") return
    syncRouteSlotStore(store, basePath, name, parsed.target, parsed.error, pending)
  })

  let current = $derived(snapshot.key === requestKey ? snapshot : undefined)
</script>

{#if current?.content}
  <Chain
    chain={current.content.chain}
    props={current.content}
    data={current.content.data}
    layoutData={current.content.layoutData}
    replaceContext={true}
  />
{:else if current?.status === "error" || parsed.error !== undefined}
  {#if error}
    {@render error(current?.error ?? parsed.error ?? "unavailable")}
  {:else}
    <div role="alert" data-route-slot-error={current?.error ?? parsed.error ?? "unavailable"}>
      This panel is unavailable.
    </div>
  {/if}
{:else if parsed.target !== undefined}
  {@render children?.()}
{/if}
