<!--
  Home route as a Vue SFC, run through the `nifra` CLI (no dev.ts/build.ts/server.ts). The plain
  <script> carries meta and the loader lives in index.backend.ts; <script setup> + <template> are
  the component. The local counter proves hydration; the scoped <style> proves the CSS pipeline - all
  through `nifra dev`.
-->
<script lang="ts">
export const meta = {
  title: "nifra CLI - Vue",
  meta: [{ name: "description", content: "nifra Vue app via the zero-config nifra CLI" }],
}
</script>

<script setup lang="ts">
import { ref } from "vue"
import type { Route } from "./+types/index"

// compose() spreads data/actionData/pending/submission as props - declare them so they aren't attrs.
// Listed rather than `defineProps<Route.ComponentProps>()`: the SFC compiler cannot follow an imported
// type through tsconfig `rootDirs`, but it can declare these keys and leave their types to TypeScript.
defineProps<{
  data: Route.LoaderData
  actionData?: Route.ActionData
  pending?: Route.ComponentProps["pending"]
  submission?: Route.ComponentProps["submission"]
}>()
const local = ref(0)
</script>

<template>
  <div>
    <h1 id="page">nifra CLI - zero-config (Vue)</h1>
    <p id="ssr">{{ data.message }}</p>
    <p id="count">server count: {{ data.count }}</p>
    <button id="local" type="button" @click="local++">local: {{ local }}</button>
  </div>
</template>

<style scoped>
#page {
  color: #42b883;
}
</style>
