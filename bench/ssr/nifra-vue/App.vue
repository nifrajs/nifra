<script setup lang="ts">
import type { CatalogPageData } from "../shared/catalog.ts"

defineProps<{ data: CatalogPageData }>()
</script>

<template>
  <main>
    <h1>Items ({{ data.items.length }})</h1>
    <ul>
      <li v-for="it in data.items" :key="it.id">{{ it.name }}</li>
    </ul>
  </main>
</template>
