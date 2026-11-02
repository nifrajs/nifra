<script lang="ts">
  import { setContext } from "svelte"
  import RouteSlot from "../../src/RouteSlot.svelte"

  let { path } = $props<{ readonly path: string }>()
  setContext("@nifrajs/web-svelte:props", () => ({ data: null, path, pending: false }))
</script>

<RouteSlot name="inspector">
  <p id="slot-fallback">Loading target</p>
</RouteSlot>
