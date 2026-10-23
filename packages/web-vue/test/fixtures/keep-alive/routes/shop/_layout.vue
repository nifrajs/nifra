<script setup lang="ts">
import { ref } from "vue"

const opened = ref(0)
</script>

<template>
  <div class="shop">
    <button type="button" class="shop-count" @click="opened++">shop {{ opened }}</button>
    <slot />
  </div>
</template>
