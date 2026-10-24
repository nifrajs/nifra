<script lang="ts">
export const keepAlive = true
</script>

<script setup lang="ts">
defineProps<{ params: Record<string, string> }>()
</script>

<template>
  <h1 id="list-title">List {{ params.id }}</h1>
</template>
