<script setup lang="ts">
import type { SummaryProps } from "../schema.shared"
defineProps<{ props: SummaryProps; islands: { picker: { html: string } }; ranges: Record<string, { html: string }> }>()
</script>
<template>leading text<section id="revision">Revision {{ props.revision }}</section><div v-if="ranges.detail && props.revision % 2 === 0" v-html="ranges.detail.html"></div><div v-html="islands.picker.html"></div><div v-if="ranges.detail && props.revision % 2 !== 0" v-html="ranges.detail.html"></div>trailing text</template>
