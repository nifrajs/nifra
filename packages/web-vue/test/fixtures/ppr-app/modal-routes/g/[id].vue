<script lang="ts">
import { closeBoundary } from "@nifrajs/web/client"
import { Hole } from "@nifrajs/web-vue/ppr"
import { h } from "vue"

const greeting = {
  name: "greeting",
  mode: "dynamic" as const,
  render: (data: { readonly name: string }) => h("p", { id: "greeting" }, `hello ${data.name}`),
  fallback: h("p", { id: "greeting-fallback" }, "loading greeting"),
}
const photo = { name: "photo", mode: { intercept: "/photo/:id" } }

export const boundaries = [greeting, photo]
</script>

<script setup lang="ts">
const props = defineProps<{
  data: { readonly title: string }
  boundaries?: Readonly<
    Record<
      string,
      {
        readonly status: "unresolved" | "pending" | "ready" | "error"
        readonly data?: { readonly title?: string }
        readonly ppr?: true
      }
    >
  >
}>()
</script>

<template>
  <main>
    <h1 id="title">{{ props.data.title }}</h1>
    <input id="probe" />
    <Hole :of="greeting" :state="props.boundaries?.greeting" />
    <a id="to-photo-7" href="/photo/7">photo 7</a>
    {{ " " }}
    <a id="to-photo-8" href="/photo/8">photo 8</a>
    <dialog v-if="props.boundaries?.photo?.status === 'ready'" open data-nifra-boundary="photo">
      <h2 id="modal-title">{{ props.boundaries.photo.data?.title }}</h2>
      <button id="close" type="button" @click="closeBoundary('photo')">close</button>
    </dialog>
  </main>
</template>
