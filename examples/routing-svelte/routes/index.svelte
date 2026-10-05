<!--
  Home route. `<script module>` exports meta (loader and action live in index.backend.ts); the
  instance `<script>` + template is the component.
-->
<script module lang="ts">
  export const meta = {
    title: "nifra + Svelte - Home",
    meta: [{ name: "description", content: "nifra Svelte bindings: loader + action + defer/Await" }],
  }
</script>

<script lang="ts">
  import Await from "@nifrajs/web-svelte/await"
  import type { Route } from "./+types/index"

  let { data, actionData }: Route.ComponentProps = $props()
</script>

<div>
  <h1 id="page">Home</h1>
  <p id="count">count: {data.count}</p>
  <form method="post"><button id="inc" type="submit">increment</button></form>
  {#if actionData}
    <Await resolve={actionData.receipt}>
      {#snippet pending()}<p id="receipt-fallback">receipt…</p>{/snippet}
      {#snippet children(receipt)}<p id="receipt">{receipt}</p>{/snippet}
    </Await>
  {/if}
</div>

<style>
  /* Scoped: Svelte rewrites to `#page.svelte-<hash>` + bakes the class into the markup; bundled into
     the app stylesheet. Proves nifra's Svelte scoped-style pipeline. */
  #page {
    color: #ff3e00;
  }
</style>
