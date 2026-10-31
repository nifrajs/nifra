<script lang="ts">
  let { data }: { readonly data: { readonly label: string } } = $props()
</script>

<p id="slot-ready">{data.label}</p>
