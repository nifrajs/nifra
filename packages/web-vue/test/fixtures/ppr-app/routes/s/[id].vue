<script lang="ts">
import { Hole } from "@nifrajs/web-vue/ppr"
import { h } from "vue"

const price = {
  name: "price",
  mode: "shared" as const,
  render: (data: { readonly amount: number }) => h("p", { id: "price" }, `price ${data.amount}`),
  fallback: h("p", { id: "price-fallback" }, "loading price"),
}
const greeting = {
  name: "greeting",
  mode: "dynamic" as const,
  render: (data: { readonly name: string }) => h("p", { id: "greeting" }, `hello ${data.name}`),
  fallback: h("p", { id: "greeting-fallback" }, "loading greeting"),
}

export const boundaries = [price, greeting]
</script>

<script setup lang="ts">
const props = defineProps<{
  data: { readonly title: string }
  boundaries?: Readonly<
    Record<
      string,
      {
        readonly status: "unresolved" | "pending" | "ready" | "error"
        readonly data?: unknown
        readonly ppr?: true
      }
    >
  >
}>()
</script>

<template>
  <main>
    <h1 id="title">{{ props.data.title }}</h1>
    <Hole :of="price" :state="props.boundaries?.price" />
    <Hole :of="greeting" :state="props.boundaries?.greeting" />
    <a id="to-s9" href="/s/9">next</a>
  </main>
</template>
