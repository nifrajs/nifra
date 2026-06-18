<!--
  Home route as a Vue SFC, run through the `nifra` CLI (no dev.ts/build.ts/server.ts). The plain
  <script> carries the loader/meta (server-only); <script setup> + <template> are the component. The
  local counter proves hydration; the scoped <style> proves the CSS pipeline — all through `nifra dev`.
-->
<script lang="ts">
import type { LoaderArgs } from "@nifrajs/client"
import type { backend } from "../backend"

export const meta = {
  title: "nifra CLI — Vue",
  meta: [{ name: "description", content: "nifra Vue app via the zero-config nifra CLI" }],
}

export async function loader({ api }: LoaderArgs<typeof backend>) {
  const hello = await api.hello.get()
  const c = await api.count.get()
  return { message: hello.data?.message ?? "", count: c.data?.count ?? 0 }
}
</script>

<script setup lang="ts">
import { ref } from "vue"

defineProps(["data", "actionData", "pending", "submission"])
const local = ref(0)
</script>

<template>
  <div>
    <h1 id="page">nifra CLI — zero-config (Vue)</h1>
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
