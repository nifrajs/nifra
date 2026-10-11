<script lang="ts">
  import ServerComponent from "@nifrajs/web-svelte/server-components/outlet"
  import { Summary } from "./Summary.component.server"
  import type { ComponentState, ComponentController, ComponentClientAdapter } from "@nifrajs/web/server-components/client"
  let { state: componentState, controller, clientAdapter }: { state: ComponentState; controller?: ComponentController; clientAdapter?: ComponentClientAdapter } = $props()
  let count = $state(0)
</script>
<main><button id="parent-counter" onclick={() => count++}>Parent {count}</button><ServerComponent state={componentState} {controller} {clientAdapter} component={Summary} instanceKey="summary" input={{}} /></main>
