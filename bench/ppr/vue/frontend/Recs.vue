<script setup lang="ts">
defineProps(["items"])
</script>

<template>
  <ul>
    <li v-for="item in items" :key="item">{{ item }}</li>
  </ul>
</template>
