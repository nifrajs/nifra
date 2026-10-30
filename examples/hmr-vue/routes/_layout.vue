<!-- Root layout - renders the page via the default slot; the nav proves client navigation works. -->
<script setup>
import { href } from "@nifrajs/web-vue/router"
</script>

<template>
  <div>
    <nav id="nav"><a :href="href({ to: '/' })">home</a> · <a :href="href({ to: '/about' })">about</a></nav>
    <slot />
  </div>
</template>
