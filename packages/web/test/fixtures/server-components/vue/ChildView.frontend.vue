<script setup lang="ts">
import type { SummaryProps } from "../schema.shared"
defineProps<{ props: SummaryProps; islands: { picker: { html: string } } }>()
</script>
<template>child-leading<table><tbody><tr><td id="child-revision">Child {{ props.revision }}</td></tr></tbody></table><svg><circle id="child-svg" cx="1" /></svg><div v-html="islands.picker.html"></div>child-trailing</template>
