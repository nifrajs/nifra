import type { ResolvedImage } from "./resolve.ts"

/** Plain lowercase HTML `<img>` attributes (`srcset`/`fetchpriority`, not React's camelCase). */
export interface HtmlImageAttrs {
  readonly src: string
  readonly width: number
  readonly height: number
  readonly alt: string
  readonly loading: "lazy" | "eager"
  readonly decoding: "async"
  readonly srcset?: string
  readonly sizes?: string
  readonly fetchpriority?: "high"
}

/**
 * Map a {@link ResolvedImage} to plain lowercase HTML `<img>` attribute names — `srcset` (not React's
 * `srcSet`), `fetchpriority` (not `fetchPriority`) — dropping unset optionals. For the adapters that
 * spread attributes straight onto a host element (Solid / Vue / Svelte / Preact); React consumes
 * `ResolvedImage` directly because it requires the camelCased prop names.
 */
export function toHtmlAttrs(resolved: ResolvedImage): HtmlImageAttrs {
  // Build the required attrs, then add optionals only when present (exactOptionalPropertyTypes:
  // never assign an explicit `undefined`). The result is safe to spread onto an <img>.
  const attrs: {
    src: string
    width: number
    height: number
    alt: string
    loading: "lazy" | "eager"
    decoding: "async"
    srcset?: string
    sizes?: string
    fetchpriority?: "high"
  } = {
    src: resolved.src,
    width: resolved.width,
    height: resolved.height,
    alt: resolved.alt,
    loading: resolved.loading,
    decoding: resolved.decoding,
  }
  if (resolved.srcSet !== undefined) attrs.srcset = resolved.srcSet
  if (resolved.sizes !== undefined) attrs.sizes = resolved.sizes
  if (resolved.fetchPriority !== undefined) attrs.fetchpriority = resolved.fetchPriority
  return attrs
}
