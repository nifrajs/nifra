<!--
  Home route (Vue SFC). The plain <script> carries nifra's loader/meta (server-only, tree-shaken from
  the client); <script setup> + <template> are the component. The view lives in <Counter> so editing
  it Fast-Refreshes with state intact; this route file full-reloads on save (it exports loader/meta).
-->
<script lang="ts">
import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { backend } from "../backend"

export const meta = {
  title: "nifra — HMR (Vue)",
  meta: [{ name: "description", content: "True HMR via @nifrajs/web/vite" }],
}

// Proves SSR still runs under the Vite dev server: this value is server-rendered into the document.
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.hello.get()
  return { message: res.data?.message ?? "" }
}
export type Data = LoaderData<typeof loader>
</script>

<script setup lang="ts">
import Counter from "../components/Counter.vue"

// compose() spreads data/actionData/pending/submission as props — declare them so they aren't attrs.
defineProps<{ data: Data; actionData?: unknown; pending?: unknown; submission?: unknown }>()
</script>

<template>
  <Counter :message="data.message" />
</template>
