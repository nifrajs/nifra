<!-- nifra's catch-all renders _404 WITHOUT the layout chain, so it wraps itself in the root Layout. -->
<script lang="ts">
export const meta = { title: "Not found" }
</script>

<script setup lang="ts">
import Layout from "./_layout.vue"
</script>

<template>
  <Layout>
    <section class="hero">
      <h1><span class="grad">404</span></h1>
      <p>That page doesn't exist.</p>
      <a class="btn" href="/">← Back home</a>
    </section>
  </Layout>
</template>
