<!-- Root layout - wraps the page via its `children` snippet (the Chain fold passes the page there). -->
<script lang="ts">
  import type { Snippet } from "svelte"

  let { children }: { children: Snippet } = $props()
</script>

<div class="wrap">{@render children()}</div>
