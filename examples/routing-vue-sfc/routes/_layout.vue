<!-- Root layout — renders the page via the default slot; the nav proves client navigation works.
     compose() passes layouts a `null` props bag, so no defineProps here. -->
<template>
  <div>
    <nav id="nav"><a href="/">home</a> · <a href="/about">about</a></nav>
    <slot />
  </div>
</template>
