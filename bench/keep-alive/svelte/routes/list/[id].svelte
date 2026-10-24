<script module>
  export const keepAlive = { revalidate: false }
</script>

<script>
  import Rows from "../../shared/Rows.svelte"
  let { data } = $props()
</script>

<Rows {data} />
