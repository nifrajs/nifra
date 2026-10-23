<script lang="ts">
import { Hole } from "@nifrajs/web-vue/ppr"
import { h } from "vue"

const note = {
  name: "note",
  mode: "dynamic" as const,
  render: (data: { readonly text: string }) => h("p", { id: "note" }, data.text),
  fallback: h("p", { id: "note-fallback" }, "loading note"),
}
export const boundaries = [note]
</script>

<script setup lang="ts">
const props = defineProps<{
  data: { readonly id: string }
  boundaries?: Readonly<Record<string, { readonly status: "unresolved" | "pending" | "ready" | "error" }>>
}>()
</script>

<template>
  <main>
    <h1 id="member">member {{ props.data.id }}</h1>
    <Hole :of="note" :state="props.boundaries?.note" />
  </main>
</template>
