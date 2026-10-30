<script module lang="ts">
export const meta = { title: "Not found" }
</script>

<script lang="ts">
  import { href } from "@nifrajs/web-svelte/router"
</script>

<section class="hero">
  <h1><span class="grad">404</span></h1>
  <p>That page doesn't exist.</p>
  <a class="btn" href={href({ to: "/" })}>← Back home</a>
</section>
