<script module>
  export const keepAlive = true
</script>

<script>
  import Rows from "../../shared/Rows.svelte"
  let { data } = $props()
</script>

<Rows {data} />
