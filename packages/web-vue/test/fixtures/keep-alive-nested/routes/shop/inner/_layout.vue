<script setup lang="ts">
import { onPageHide, usePageVisibility } from "@nifrajs/web-vue/router"
import { watch } from "vue"

// What this layout hears as the kept branch it renders in is hidden.
const log = (entry: string): void => {
  const held: string[] = Reflect.get(window, "__heard") ?? []
  held.push(entry)
  Reflect.set(window, "__heard", held)
}
const visible = usePageVisibility()
watch(visible, (now) => log(`inner:${now}`))
onPageHide(() => log("inner:hide"))
</script>

<template>
  <div class="inner"><slot /></div>
</template>
