<script setup lang="ts">
const props = defineProps<{ data?: unknown; boundaries?: unknown }>()
</script>

<template>
  <section
    id="members"
    :data-member="
      typeof props.data === 'object' && props.data !== null && 'member' in props.data ? 'yes' : 'no'
    "
  >
    <slot />
  </section>
</template>
