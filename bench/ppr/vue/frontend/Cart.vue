<script setup lang="ts">
import { ref } from "vue"

const props = defineProps(["count"])
const count = ref(props.count)
</script>

<template>
  <button type="button" @click="count++">cart {{ count }}</button>
</template>
