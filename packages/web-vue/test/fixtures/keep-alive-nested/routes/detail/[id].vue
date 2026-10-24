<script setup lang="ts">
defineProps<{ params: Record<string, string> }>()
</script>

<template>
  <p class="detail">Detail {{ params.id }}</p>
</template>
