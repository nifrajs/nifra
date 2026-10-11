<script setup lang="ts">
import { ref, onMounted, onUnmounted, Teleport } from "vue"
import { componentPortalTarget } from "@nifrajs/web/server-components/portal"
const root = ref<HTMLElement>()
const target = ref<HTMLElement>()
const portal = ref<Element>()
onMounted(() => { portal.value = componentPortalTarget(root.value!, target.value!) })
defineProps<{ title: string; prefix?: string; slots?: Record<string, string> }>()
const count = ref(0)
onMounted(() => window.dispatchEvent(new Event("fixture:mounted")))
onUnmounted(() => window.dispatchEvent(new Event("fixture:disposed")))
</script>
<template><article ref="root"><h2>{{ title }}</h2><button :id="(prefix ?? '') + 'counter'" @click="count++">Count {{ count }}</button><input :id="(prefix ?? '') + 'value'" value="original"><div v-if="slots?.summary" v-html="slots.summary"></div><div ref="target" data-nifra-portal="details"></div><Teleport v-if="portal" :to="portal"><span :id="(prefix ?? '') + 'portal'">Portal {{ title }}</span></Teleport></article></template>
