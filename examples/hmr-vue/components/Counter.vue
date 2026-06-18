<!--
  Component-only SFC → a Vue HMR boundary. Editing the <template> (e.g. the <h1> text) triggers Vue's
  rerender path with `count` state PRESERVED (no reload) — keep a route's view here; the route file
  (which exports loader/meta in a plain <script>) full-reloads on save.
-->
<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: biome's Vue SFC support doesn't track
// `<template>` bindings, so it false-flags `count` (used via {{ count }} / @click) as unused.
import { ref } from "vue"

// `message` is the loader data nifra's compose threads in; the counter proves the SFC hydrated.
defineProps(["message"])
const count = ref(0)
</script>

<template>
  <div>
    <h1 id="page">nifra + Vite — true HMR (Vue)</h1>
    <p id="ssr">{{ message }}</p>
    <p id="count">count: {{ count }}</p>
    <button id="inc" type="button" @click="count++">increment</button>
  </div>
</template>
