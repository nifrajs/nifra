<script lang="ts">
export const keepAlive = true
</script>

<script setup lang="ts">
import { ref } from "vue"

defineProps<{ params: Record<string, string> }>()
const count = ref(0)
</script>

<template>
  <article class="item">
    <h1>Item {{ params.item }}</h1>
    <button type="button" class="item-count" @click="count++">item {{ count }}</button>
  </article>
</template>
