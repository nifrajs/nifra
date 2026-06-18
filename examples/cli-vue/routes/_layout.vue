<!-- Root layout — the nav proves client navigation; compose() passes layouts a null props bag. -->
<template>
  <div>
    <nav id="nav"><a href="/">home</a></nav>
    <slot />
  </div>
</template>
