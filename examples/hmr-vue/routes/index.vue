<!--
  Home route (Vue SFC). The plain <script> carries nifra's loader/meta (server-only, tree-shaken from
  the client); <script setup> + <template> are the component. The view lives in <Counter> so editing
  it Fast-Refreshes with state intact; this route file full-reloads on save (it exports loader/meta).
-->
<script lang="ts">
import type { loader } from "./index.backend.ts"
import type { LoaderData } from "@nifrajs/client"

export const meta = {
  title: "nifra - HMR (Vue)",
  meta: [{ name: "description", content: "True HMR via @nifrajs/web/vite" }],
}
export type Data = LoaderData<typeof loader>
</script>

<script setup lang="ts">
import Counter from "../frontend/components/Counter.vue"

// compose() spreads data/actionData/pending/submission as props - declare them so they aren't attrs.
defineProps<{ data: Data; actionData?: unknown; pending?: unknown; submission?: unknown }>()
</script>

<template>
  <Counter :message="data.message" />
</template>
