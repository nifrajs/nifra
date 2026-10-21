<script lang="ts">
import { Hole } from "@nifrajs/web-vue/ppr"
import { h } from "vue"
import Cart from "../../frontend/Cart.vue"
import Greeting from "../../frontend/Greeting.vue"
import Loading from "../../frontend/Loading.vue"
import Recs from "../../frontend/Recs.vue"

const greeting = {
  name: "greeting",
  mode: "dynamic" as const,
  render: (data: { readonly name: string }) => h(Greeting, { name: data.name }),
  fallback: h(Loading, { text: "loading greeting" }),
}
const cart = {
  name: "cart",
  mode: "dynamic" as const,
  interactive: true,
  render: (data: { readonly count: number }) => h(Cart, { count: data.count }),
  fallback: h(Loading, { text: "loading cart" }),
}
const recs = {
  name: "recs",
  mode: "dynamic" as const,
  render: (data: { readonly items: readonly string[] }) => h(Recs, { items: data.items }),
  fallback: h(Loading, { text: "loading recommendations" }),
}
export const boundaries = [greeting, cart, recs]
</script>

<script setup lang="ts">
import ProductPage from "../../frontend/ProductPage.vue"

const props = defineProps(["data", "boundaries"])
</script>

<template>
  <ProductPage :product="props.data.product">
    <Hole :of="greeting" :state="props.boundaries?.greeting" />
    <Hole :of="cart" :state="props.boundaries?.cart" />
    <Hole :of="recs" :state="props.boundaries?.recs" />
  </ProductPage>
</template>
