<script setup lang="ts">
import { catalogItems } from "~/lib/catalog"

const items = catalogItems()
</script>

<template>
  <main>
    <h1>Items ({{ items.length }})</h1>
    <ul>
      <li v-for="it in items" :key="it.id">{{ it.name }}</li>
    </ul>
  </main>
</template>
