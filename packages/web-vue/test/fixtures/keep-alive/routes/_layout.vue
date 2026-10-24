<script setup lang="ts">
// The second rule would stop matching inside slot wrappers; a Vue page renders none, so it still does.
const css = "<style>.list-page { min-height: 1400px } #main > .list-page { outline: 1px solid }</style>"
</script>

<template>
  <div class="shell">
    <div v-html="css" />
    <nav>
      <a href="/">home</a> <a href="/list/1">list 1</a> <a href="/list/2">list 2</a>
      <a href="/list/3">list 3</a> <a href="/detail/1">detail 1</a> <a href="/shop/a">shop a</a>
      <a href="/shop/b">shop b</a>
    </nav>
    <main id="main"><slot /></main>
  </div>
</template>
