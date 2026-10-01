<script module lang="ts">
export const meta = {
  title: "nifra site",
  meta: [{ name: "description", content: "A nifra + Svelte SSR site, deployable to every runtime." }],
}
</script>

<script lang="ts">
  let { data } = $props()
</script>

<section class="hero">
  <h1>Your nifra app,<br /><span class="grad">everywhere.</span></h1>
  <p>
    SSR + hydration, end-to-end types, Svelte. One source - deploy to Cloudflare Pages, Node, Deno,
    or Vercel Edge. Edit <code>routes/index.svelte</code> to begin.
  </p>
</section>

<div class="card">
  <div>
    <h3>Live full-stack loop</h3>
    <p>
      Count is rendered by a typed <code>loader</code>, incremented by an <code>action</code>,
      revalidated with no full reload.
    </p>
  </div>
  <form method="post" style="display:flex;align-items:center;gap:16px">
    <span class="count">{data.count}</span>
    <button class="btn" type="submit">increment →</button>
  </form>
</div>
