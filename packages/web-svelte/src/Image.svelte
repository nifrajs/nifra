<!--
  Image.svelte — a CLS-safe responsive <Image> for nifra + Svelte. A thin wrapper over `resolveImage` +
  `toHtmlAttrs` from @nifrajs/image: it computes the responsive <img> attributes (src/srcset/sizes/width/
  height/loading/decoding/fetchpriority — lowercase HTML names) and renders an <img>. Any extra
  attributes (class/style/id/data-*/handlers in `...rest`) pass through. `width`+`height` are required
  (reserve layout space — no CLS); `priority` marks the LCP image. Resizing is delegated to the
  `loader` (an image CDN); nifra bundles no codec. Plain-JS script (no TS preprocessor needed).
-->
<script>
  import { resolveImage, toHtmlAttrs } from "@nifrajs/image"

  let { src, width, height, alt, sizes, widths, quality, loading, priority, loader, ...rest } = $props()

  // `$derived` keeps the attributes in sync if props change. Build ImageProps omitting unset optionals;
  // resolveImage validates width/height > 0 (the CLS contract) and builds the responsive srcSet.
  const attrs = $derived.by(() => {
    const input = { src, width, height, alt }
    if (sizes !== undefined) input.sizes = sizes
    if (widths !== undefined) input.widths = widths
    if (quality !== undefined) input.quality = quality
    if (loading !== undefined) input.loading = loading
    if (priority !== undefined) input.priority = priority
    return toHtmlAttrs(resolveImage(input, loader))
  })
</script>

<img {...rest} {...attrs} />
