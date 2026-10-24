<script lang="ts">
export const keepAlive = true

const ticks = (): Record<string, number> => {
  const held: Record<string, number> | undefined = Reflect.get(globalThis, "__ticks")
  if (held !== undefined) return held
  const fresh: Record<string, number> = {}
  Reflect.set(globalThis, "__ticks", fresh)
  return fresh
}
// The list pages mounted, kept ones included: there are no slot wrappers to count.
const mounted = (): Set<string> => {
  const held: Set<string> | undefined = Reflect.get(globalThis, "__mounted")
  if (held !== undefined) return held
  const fresh = new Set<string>()
  Reflect.set(globalThis, "__mounted", fresh)
  return fresh
}
const lines = Array.from({ length: 40 }, (_, i) => i)
</script>

<script setup lang="ts">
import { onPageHide, onPageShow, usePageVisibility } from "@nifrajs/web-vue/router"
import { onMounted, onUnmounted, ref, useId } from "vue"

defineProps<{
  data: { id: string; items: { id: number; label: string }[] }
  params: Record<string, string>
}>()
const instance = useId()
const count = ref(0)
const visible = usePageVisibility()
let timer: ReturnType<typeof setInterval> | undefined
const start = () => {
  timer = setInterval(() => {
    const all = ticks()
    all[instance] = (all[instance] ?? 0) + 1
  }, 10)
}
onMounted(() => {
  mounted().add(instance)
  start()
})
onUnmounted(() => {
  mounted().delete(instance)
  clearInterval(timer)
})
onPageHide(() => clearInterval(timer))
onPageShow(start)
</script>

<template>
  <section class="list-page" :data-instance="instance" :data-param="params.id" :data-visible="String(visible)">
    <h1 id="list-title">List {{ data.id }}</h1>
    <button type="button" class="count" @click="count++">count {{ count }}</button>
    <details class="more">
      <summary>More</summary>
      <p>Details for list {{ data.id }}</p>
    </details>
    <input class="draft" value="" />
    <div class="inner-scroll" style="height: 80px; overflow: auto">
      <p v-for="i in lines" :key="i">line {{ i }}</p>
    </div>
    <ul>
      <li v-for="item in data.items" :key="item.id" :data-id="item.id">
        <span>{{ item.label }}</span>
        <input type="checkbox" />
      </li>
    </ul>
  </section>
</template>
