<script lang="ts">
  import type { Component } from "svelte"
  let { component: Native, state, slots }: { component: Component<Record<string, unknown>>; state: { props: Record<string, unknown> }; slots: Record<string, string> } = $props()
</script>
<Native {...state.props} {slots} />
