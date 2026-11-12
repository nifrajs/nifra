<script>
  import { provideQueryClient } from "../../src/query.ts"
  let { client, state, children } = $props()
  provideQueryClient(client, state)
</script>

{@render children()}
