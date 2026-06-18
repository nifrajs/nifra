<!--
  Home route, authored as a Vue SFC. The plain <script> carries nifra's route convention (loader/action/
  meta — server-only named exports the client codegen tree-shakes out); <script setup> + <template> are
  the component. The local counter proves the SFC HYDRATED (Vue reactivity works after SSR); the form is
  the SSR action path (progressive enhancement). Compiled by @nifrajs/web-vue/plugin.
-->
<script lang="ts">
import type { ActionArgs, LoaderArgs } from "@nifrajs/client"
import type { backend } from "../backend"

export const meta = {
  title: "nifra + Vue SFC — Home",
  meta: [{ name: "description", content: "nifra Vue SFC: loader + action + client hydration" }],
}

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}

export async function action({ api }: ActionArgs<typeof backend>) {
  await api.count.post() // the client submit revalidates the loader → count updates, no full reload
  return { ok: true }
}
</script>

<script setup lang="ts">
import { ref } from "vue"

// compose() spreads data/actionData/pending/submission as props — declare them so they aren't attrs.
defineProps(["data", "actionData", "pending", "submission"])

// A client-only counter: if clicking it increments, the SFC hydrated (reactivity is live post-SSR).
const local = ref(0)
</script>

<template>
  <div>
    <h1 id="page">Home (Vue SFC)</h1>
    <p id="count">server count: {{ data.count }}</p>
    <form method="post"><button id="inc" type="submit">increment (action)</button></form>
    <button id="local" type="button" @click="local++">local: {{ local }}</button>
  </div>
</template>

<style scoped>
/* Scoped: rewritten to `#page[data-v-<id>]` at build (the matching attribute is baked into the
   markup), bundled into the app stylesheet. Proves nifra's Vue scoped-style pipeline. */
#page {
  color: #7c5cff;
}
</style>
