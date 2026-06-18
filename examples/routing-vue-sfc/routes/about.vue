<!-- A second route — the client-nav target. Template-only-ish (just a meta export + a <template>),
     exercising the no-<script setup> path of the compiler. -->
<script>
export const meta = { title: "nifra + Vue SFC — About" }
</script>

<template>
  <div>
    <h1 id="page">About (Vue SFC)</h1>
    <p>A second route, reached via client navigation from the nav above.</p>
  </div>
</template>
