<script lang="ts" generics="Input, Props, View">
  import Range from "./Range.svelte"
  import { ComponentController, resolveComponentRecord, type ComponentClientAdapter, type ComponentState, type ComponentKey, type ServerComponent as Handle } from "@nifrajs/web/server-components/client"
  let { state, component, instanceKey, input, parent, controller, clientAdapter }: {
    state: ComponentState; component: Handle<Input, Props, View>; instanceKey: ComponentKey; input: NoInfer<Input>; parent?: string; controller?: ComponentController | undefined; clientAdapter?: ComponentClientAdapter | undefined
  } = $props()
  const record = $derived(resolveComponentRecord(state, component, instanceKey, input, parent ?? null))
</script>
{#key record.instance}<Range {state} {record} {controller} {clientAdapter} />{/key}
