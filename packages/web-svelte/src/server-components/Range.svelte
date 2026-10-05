<script lang="ts">
  import { onMount } from "svelte"
  import { ComponentController, type ComponentClientAdapter, type ComponentState, type ComponentRecord } from "@nifrajs/web/server-components/client"
  let { state, record, controller, clientAdapter }: { state: ComponentState; record: ComponentRecord; controller?: ComponentController | undefined | undefined; clientAdapter?: ComponentClientAdapter | undefined | undefined } = $props()
  // svelte-ignore state_referenced_locally
  const initial = record.html
  // svelte-ignore state_referenced_locally
  const instance = record.instance
  let host: HTMLElement
  let active: ComponentController | undefined
  onMount(() => {
    if (controller === undefined && clientAdapter === undefined) throw new Error("component_contract")
    active = controller ?? new ComponentController({ state, adapter: clientAdapter! })
    void active.mount(host, instance).catch(() => active?.reportError("component_failed"))
    return () => { if (active !== undefined) void (controller === undefined ? active.dispose() : active.unmount(instance)) }
  })
  $effect(() => { const next = state; if (active !== undefined) void active.adopt(next).catch(() => active?.reportError("component_failed")) })
</script>
<nifra-component bind:this={host} data-nifra-component={instance}>{@html initial}</nifra-component>
