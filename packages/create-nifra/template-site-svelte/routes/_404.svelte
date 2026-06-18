<script module lang="ts">
export const meta = { title: "Not found" }
</script>

<script lang="ts">
  // nifra's catch-all renders _404 without the layout chain, so it wraps itself in the root Layout.
  import Layout from "./_layout.svelte"
</script>

<Layout>
  <section class="hero">
    <h1><span class="grad">404</span></h1>
    <p>That page doesn't exist.</p>
    <a class="btn" href="/">← Back home</a>
  </section>
</Layout>
