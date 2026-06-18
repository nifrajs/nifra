<!-- A route SFC fixture: plain <script> carries nifra's loader/meta named exports; <script setup> is the
     component; <template> reads the loader data prop. The scoped <style> exercises the CSS pipeline: the
     dom build extracts it to a virtual ?vue-css module (scoped to #title[data-v-<id>]); the ssr build
     emits no CSS but bakes the matching data-v-<id> attribute into the markup. -->
<script>
export const meta = { title: "Vue SFC route" }
export async function loader() {
  return { greeting: "hello from the SFC loader" }
}
</script>

<script setup>
defineProps(["data", "actionData", "pending", "submission"])
</script>

<template>
  <main>
    <h1 id="title">SFC page</h1>
    <p id="msg">{{ data.greeting }}</p>
  </main>
</template>

<style scoped>
#title { color: rebeccapurple; }
</style>
