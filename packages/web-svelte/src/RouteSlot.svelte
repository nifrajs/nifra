<script lang="ts">
  import type { RenderProps, RouteSlotName } from "@nifrajs/web"
  import type { LoadedRouteSlot } from "@nifrajs/web/client"
  import type { Snippet } from "svelte"
  import {
    getRouteSlotRuntime,
    loadRouteSlot,
    onRouteSlotIdentityChange,
    parseRouteSlots,
    RouteSlotLoadError,
    RouteSlotStateError,
    stripRouteSlots,
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
  let parsed = $derived.by(() => {
    try {
      return { target: parseRouteSlots(path)[name], error: undefined }
    } catch (cause) {
      return {
        target: undefined,
        error: cause instanceof RouteSlotStateError ? cause.code : "malformed",
      }
    }
  })
  let refreshEpoch = $state(0)
  let activeController: AbortController | undefined
  let requestEpoch = 0
  let state = $state<{
    key?: string
    status: "idle" | "loading" | "ready" | "error"
    content?: LoadedRouteSlot
    error?: string
  }>({ status: "idle" })
  let requestKey = $derived(
    `${stripRouteSlots(path)}\0${name}\0${parsed.target ?? ""}\0${refreshEpoch}\0${pending ? 1 : 0}`,
  )

  $effect(() => {
    const currentPath = path
    const isPending = pending
    const current = parsed
    const key = requestKey
    const epoch = ++requestEpoch
    const controller = new AbortController()
    activeController = controller
    const cleanup = (): void => {
      controller.abort()
      if (activeController === controller) activeController = undefined
    }
    if (isPending) {
      state = { key, status: "idle" }
      return cleanup
    }
    if (current.error !== undefined) {
      state = { key, status: "error", error: current.error }
      return cleanup
    }
    if (current.target === undefined) {
      state = { key, status: "idle" }
      return cleanup
    }
    const runtime = getRouteSlotRuntime()
    if (runtime === undefined) {
      state = { key, status: "error", error: "unavailable" }
      return cleanup
    }
    state = { key, status: "loading" }
    void loadRouteSlot(runtime, name, stripRouteSlots(currentPath), current.target, controller.signal)
      .then((content) => {
        if (!controller.signal.aborted && requestEpoch === epoch)
          state = { key, status: "ready", content }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && requestEpoch === epoch)
          state = {
            key,
            status: "error",
            error: cause instanceof RouteSlotLoadError ? cause.code : "unavailable",
          }
      })
    return cleanup
  })

  $effect(() => {
    const refresh = (): void => {
      requestEpoch++
      activeController?.abort()
      activeController = undefined
      state = { status: "idle" }
      refreshEpoch += 1
    }
    const unsubscribe = onRouteSlotIdentityChange(refresh)
    window.addEventListener("focus", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      unsubscribe()
    }
  })
</script>

{#if state.key === requestKey && state.content}
  <Chain
    chain={state.content.chain}
    props={state.content}
    data={state.content.data}
    layoutData={state.content.layoutData}
    replaceContext={true}
  />
{:else if state.key === requestKey && state.status === "error"}
  {#if error}
    {@render error(state.error ?? "unavailable")}
  {:else}
    <div role="alert" data-route-slot-error={state.error ?? "unavailable"}>This panel is unavailable.</div>
  {/if}
{:else if parsed.target !== undefined}
  {@render children?.()}
{/if}
