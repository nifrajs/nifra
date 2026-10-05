<script>
  import { useMatches } from "../../src/router.ts"
  // A layout gets `children`, the page does not - which is how this one fixture reports where it sits.
  let { children } = $props()
  const matches = useMatches()
</script>

<div data-at={children ? "layout" : "page"}>{JSON.stringify(matches().map((m) => [m.id, m.pathname, m.handle, m.data]))}{@render children?.()}</div>
