<script lang="ts">
export const keepAlive = true
</script>

<script setup lang="ts">
import { onPageHide, usePageVisibility } from "@nifrajs/web-vue/router"
import { onUnmounted, watch } from "vue"

const props = defineProps<{ params: Record<string, string> }>()
const log = (entry: string): void => {
  const held: string[] = Reflect.get(window, "__heard") ?? []
  held.push(entry)
  Reflect.set(window, "__heard", held)
}
const visible = usePageVisibility()
watch(visible, (now) => log(`page:${now}`))
onPageHide(() => log("page:hide"))
onUnmounted(() => log(`page:unmounted:${props.params.x}`))
</script>

<template>
  <h1 id="item-title">Item {{ params.x }}</h1>
</template>
