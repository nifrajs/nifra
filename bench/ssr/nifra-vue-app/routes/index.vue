<script lang="ts">
export const meta = { title: "nifra SSR bench (Vue)" }
</script>

<script setup lang="ts">
import type { LoaderData } from "@nifrajs/client"
import type { loader } from "./index.backend"

defineProps<{ data: LoaderData<typeof loader> }>()
</script>

<template>
  <main>
    <h1>Items ({{ data.items.length }})</h1>
    <ul>
      <li v-for="it in data.items" :key="it.id">{{ it.name }}</li>
    </ul>
  </main>
</template>
