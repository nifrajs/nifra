<script setup lang="ts">
import { Await } from "@nifrajs/web-vue/await"
import Cart from "../../frontend/Cart.vue"
import Greeting from "../../frontend/Greeting.vue"
import Loading from "../../frontend/Loading.vue"
import ProductPage from "../../frontend/ProductPage.vue"
import Recs from "../../frontend/Recs.vue"

defineProps(["data"])
</script>

<template>
  <ProductPage :product="data.product">
    <Await :resolve="data.greeting">
      <template #default="value"><Greeting :name="value.name" /></template>
      <template #fallback><Loading text="loading greeting" /></template>
    </Await>
    <Await :resolve="data.cart">
      <template #default="value"><Cart :count="value.count" /></template>
      <template #fallback><Loading text="loading cart" /></template>
    </Await>
    <Await :resolve="data.recs">
      <template #default="value"><Recs :items="value.items" /></template>
      <template #fallback><Loading text="loading recommendations" /></template>
    </Await>
  </ProductPage>
</template>
