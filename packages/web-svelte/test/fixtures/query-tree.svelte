<script>
  import QueryProvider from "./query-provider.svelte"
  import QueryReader from "./query-reader.svelte"
  let { client, state, fetcher } = $props()
</script>

<QueryProvider {client} {state}><QueryReader {fetcher} /></QueryProvider>
