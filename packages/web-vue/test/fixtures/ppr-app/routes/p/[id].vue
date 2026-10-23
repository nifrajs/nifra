<script lang="ts">
import { Hole } from "@nifrajs/web-vue/ppr"
import { defineComponent, h, ref } from "vue"

const Cart = defineComponent({
  props: { count: { type: Number, required: true } },
  setup(props) {
    const count = ref(props.count)
    return () =>
      h("button", { id: "cart", type: "button", onClick: () => count.value++ }, `cart ${count.value}`)
  },
})

const greeting = {
  name: "greeting",
  mode: "dynamic" as const,
  render: (data: { readonly name: string }) => h("p", { id: "greeting" }, `hello ${data.name}`),
  fallback: h("p", { id: "greeting-fallback" }, "loading greeting"),
}
const cart = {
  name: "cart",
  mode: "dynamic" as const,
  interactive: true,
  render: (data: { readonly count: number }) => h(Cart, { count: data.count }),
  fallback: h("p", { id: "cart-fallback" }, "loading cart"),
}
const slow = {
  name: "slow",
  mode: "dynamic" as const,
  render: (data: { readonly at: number }) => h("p", { id: "slow" }, `slow ${data.at}`),
  fallback: h("p", { id: "slow-fallback" }, "loading slow"),
}

export const boundaries = [greeting, cart, slow]

export const meta = (args: {
  readonly origin: string
  readonly params: Readonly<Record<string, string>>
}) => ({ link: [{ rel: "canonical", href: `${args.origin}/p/${args.params.id}` }] })
</script>

<script setup lang="ts">
const props = defineProps<{
  data: { readonly title: string }
  boundaries?: Readonly<
    Record<
      string,
      {
        readonly status: "unresolved" | "pending" | "ready" | "error"
        readonly data?: unknown
        readonly ppr?: true
      }
    >
  >
}>()
</script>

<template>
  <main>
    <h1 id="title">{{ props.data.title }}</h1>
    <Hole :of="greeting" :state="props.boundaries?.greeting" />
    <Hole :of="cart" :state="props.boundaries?.cart" />
    <Hole :of="slow" :state="props.boundaries?.slow" />
  </main>
</template>
