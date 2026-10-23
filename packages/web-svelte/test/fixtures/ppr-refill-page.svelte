<!-- A page with one hole whose state the test reloads, as the router publishes a new one. -->
<script>
  import Hole from "../../src/Hole.svelte"

  let { of, initial } = $props()
  let state = $state.raw(initial)

  export function reload(next) {
    state = next
  }
</script>

<main><Hole {of} {state} /></main>
