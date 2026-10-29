<script>
  import { useQuery } from "../../src/query.ts"
  let { fetcher } = $props()
  const query = useQuery(["svelte", "request"], fetcher)
</script>

<span>{$query.data}</span>
