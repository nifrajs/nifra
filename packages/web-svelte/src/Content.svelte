<!--
  Content.svelte — render trusted pre-rendered HTML (e.g. a @nifrajs/content collection entry's `.html`)
  into the DOM via Svelte's {@html}. Pairs with content collections: <Content html={entry.html} />.
  `as` picks the wrapper element; extra attributes in `...rest` (class/style/id/data-*) pass through.

  Security: {@html} injects raw HTML, so `html` MUST be trusted (your own Markdown/content, rendered at
  build/server time) — never pass user-supplied HTML without sanitizing it first. Plain-JS script.
-->
<script>
  let { html, as = "div", ...rest } = $props()
</script>

<svelte:element this={as} {...rest}>{@html html}</svelte:element>
