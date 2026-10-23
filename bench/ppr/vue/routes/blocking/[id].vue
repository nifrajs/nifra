<script setup lang="ts">
import Cart from "../../frontend/Cart.vue"
import Greeting from "../../frontend/Greeting.vue"
import ProductPage from "../../frontend/ProductPage.vue"
import Recs from "../../frontend/Recs.vue"

defineProps(["data"])
</script>

<template>
  <ProductPage :product="data.product">
    <Greeting :name="data.greeting.name" />
    <Cart :count="data.cart.count" />
    <Recs :items="data.recs.items" />
  </ProductPage>
</template>
