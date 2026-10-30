<script lang="ts">
export const meta = { title: "Not found" }
</script>

<script setup lang="ts">
import { href } from "@nifrajs/web-vue/router"
</script>

<template>
  <section class="hero">
    <h1><span class="grad">404</span></h1>
    <p>That page doesn't exist.</p>
    <a class="btn" :href="href({ to: '/' })">← Back home</a>
  </section>
</template>
