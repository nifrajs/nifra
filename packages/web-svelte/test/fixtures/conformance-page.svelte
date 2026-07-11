<script>
  let { data, pending = false } = $props()
</script>

<p data-page="leaf" data-pending={String(pending)}>{data.name}</p>
