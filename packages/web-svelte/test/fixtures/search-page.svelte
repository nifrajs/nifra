<script>
  import { useSearch } from "../../src/router.ts"
  // useSearch returns an accessor; call it to read the current search (provided by Chain via context).
  const search = useSearch("/test-loose")
</script>

<span data-search>{search().page}</span>
