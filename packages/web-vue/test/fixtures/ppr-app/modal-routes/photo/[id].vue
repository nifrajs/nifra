<script setup lang="ts">
defineProps<{ data: { readonly title: string } }>()
</script>

<template>
  <h1 id="photo-page">{{ data.title }}</h1>
</template>
