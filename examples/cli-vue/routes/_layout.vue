<!-- Root layout - the nav proves client navigation; compose() passes layouts a null props bag. -->
<script setup>
import { href } from "@nifrajs/web-vue/router"
</script>

<template>
  <div>
    <nav id="nav"><a :href="href({ to: '/' })">home</a></nav>
    <slot />
  </div>
</template>
