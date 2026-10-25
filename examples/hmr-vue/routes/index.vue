<!--
  Home route (Vue SFC). The plain <script> carries meta (the loader lives in index.backend.ts);
  <script setup> + <template> are the component. The view lives in <Counter> so editing it
  Fast-Refreshes with state intact; this route file full-reloads on save (it exports meta).
-->
<script lang="ts">
export const meta = {
  title: "nifra - HMR (Vue)",
  meta: [{ name: "description", content: "True HMR via @nifrajs/web/vite" }],
}
</script>

<script setup lang="ts">
import Counter from "../frontend/components/Counter.vue"
import type { Route } from "./+types/index"

// A page gets only the route props it declares. Listed rather than
// `defineProps<Route.ComponentProps>()`: the SFC compiler cannot follow an imported type through
// tsconfig `rootDirs`, but it can declare the keys a page reads and leave their types to TypeScript.
defineProps<{ data: Route.LoaderData }>()
</script>

<template>
  <Counter :message="data.message" />
</template>
