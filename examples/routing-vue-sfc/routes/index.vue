<!--
  Home route, authored as a Vue SFC. The plain <script> carries meta (loader and action live in
  index.backend.ts); <script setup> + <template> are the component. The local counter proves the SFC HYDRATED (Vue reactivity works after SSR); the form is
  the SSR action path (progressive enhancement). Compiled by @nifrajs/web-vue/plugin.
-->
<script lang="ts">
export const meta = {
  title: "nifra + Vue SFC - Home",
  meta: [{ name: "description", content: "nifra Vue SFC: loader + action + client hydration" }],
}
</script>

<script setup lang="ts">
import { ref } from "vue"

// compose() spreads data/actionData/pending/submission as props - declare them so they aren't attrs.
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
