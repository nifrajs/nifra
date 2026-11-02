<!-- Root layout - wraps every page via its children snippet; the nav proves client nav works. -->
<script>
  import { href } from "@nifrajs/web-svelte/router"
  let { children } = $props()
</script>

<div>
  <nav id="nav"><a href={href({ to: "/" })}>home</a> · <a href={href({ to: "/about" })}>about</a></nav>
  {@render children()}
</div>
