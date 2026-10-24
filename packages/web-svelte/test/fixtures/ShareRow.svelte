<script>
  let { row } = $props()
  $effect(() => {
    void row
    globalThis.shareCounts.rows++
  })
</script>

<li data-id={row.id}><input type="checkbox" />{row.label}</li>
