<script setup lang="ts">
import { catalogItems } from "~/lib/catalog"

const { data } = await useAsyncData("ssr-bench-catalog", () => ({ items: catalogItems() }), {
  getCachedData: () => undefined,
})
</script>

<template>
  <main>
    <h1>Items ({{ data?.items.length ?? 0 }})</h1>
    <ul>
      <li v-for="it in data?.items ?? []" :key="it.id">{{ it.name }}</li>
    </ul>
  </main>
</template>
