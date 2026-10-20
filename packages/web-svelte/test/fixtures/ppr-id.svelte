<script>
  let { label } = $props()
  const id = $props.id()
</script>

<label for={id}>{label}</label><input {id} />
