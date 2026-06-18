import type { ImageLoader } from "@nifrajs/image"

/**
 * A stand-in CDN loader for this demo: maps `(src, width, quality)` → `src?w=W[&q=Q]`, which the example
 * server serves as a labeled SVG (so you can *see* which `srcSet` candidate the browser picked). It's a
 * pure URL builder — browser-safe, so a route module can import it without leaking anything server-only.
 *
 * A real app swaps this for `cloudflareLoader()` (from `@nifrajs/image`) or any other CDN URL builder.
 */
export const localLoader: ImageLoader = ({ src, width, quality }) =>
  `${src}?w=${width}${quality === undefined ? "" : `&q=${quality}`}`
