<!-- Root layout — renders the page via the default slot; the nav proves client navigation works. -->
<template>
  <div>
    <nav id="nav"><a href="/">home</a> · <a href="/about">about</a></nav>
    <slot />
  </div>
</template>
