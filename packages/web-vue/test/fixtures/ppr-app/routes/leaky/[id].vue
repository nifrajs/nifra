<script lang="ts">
import { Hole } from "@nifrajs/web-vue/ppr"
import { h } from "vue"

const note = {
  name: "note",
  mode: "dynamic" as const,
  render: (data: { readonly text: string }) => h("p", { id: "note" }, data.text),
  fallback: h("p", null, "loading note"),
}
export const boundaries = [note]
</script>

<script setup lang="ts">
const props = defineProps<{
  data: { readonly who: string }
  boundaries?: Readonly<Record<string, { readonly status: "unresolved" | "pending" | "ready" | "error" }>>
}>()
</script>

<template>
  <main>
    <h1 id="leaky">{{ props.data.who }}</h1>
    <Hole :of="note" :state="props.boundaries?.note" />
  </main>
</template>
