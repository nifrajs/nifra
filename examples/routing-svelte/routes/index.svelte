<!--
  Home route. `<script module>` exports loader/action/meta (server-only — named ESM exports the nifra
  codegen tree-shakes out of the client bundle); the instance `<script>` + template is the component.
-->
<script module>
  import { defer } from "@nifrajs/web"

  export const meta = {
    title: "nifra + Svelte — Home",
    meta: [{ name: "description", content: "nifra Svelte bindings: loader + action + defer/Await" }],
  }

  // SSG: prerender this static route to dist/index.html at build (build.ts → prerenderRoutes). Proves
  // the prerender pipeline is framework-agnostic — same opt-in flag, Svelte SSR output. `defer()` lives
  // only in the action, so the prerendered GET is clean.
  export const prerender = true

  export async function loader({ api }) {
    const res = await api.count.get()
    return { count: res.data?.count ?? 0 }
  }

  export async function action({ api }) {
    await api.count.post()
    // defer() in an ACTION: the mutation returns immediately; the slow receipt resolves into <Await>.
    return {
      ok: true,
      receipt: defer(new Promise((resolve) => setTimeout(() => resolve("receipt #1042"), 200))),
    }
  }
</script>

<script>
  import Await from "@nifrajs/web-svelte/await"
  let { data, actionData } = $props()
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
