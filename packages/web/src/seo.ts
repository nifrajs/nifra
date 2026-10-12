/**
 * Head helpers for a route's `meta`: `canonical()`, `openGraph()` and `jsonLd()`. `meta()` runs on the
 * server and in the browser, and this entry imports nothing at runtime, so browser code can take the
 * helpers from here without bundling the server modules the package root also exports.
 */
import type { LinkDescriptor, MetaDescriptor, ScriptDescriptor } from "./manifest.ts"

/**
 * A `<link rel="canonical">` descriptor for a route's `meta.link`. The canonical URL tells search
 * engines which URL is authoritative for a page (deduping query-string / tracking variants).
 *
 * ```ts
 * export const meta = (a) => ({ link: [canonical(`https://site.com/posts/${a.params.slug}`)] })
 * ```
 */
export function canonical(href: string): LinkDescriptor {
  return { rel: "canonical", href }
}

/** Inputs for {@link openGraph} - the common Open Graph properties. All optional; only the provided
 * ones become tags. `type` defaults to `"website"`. */
export interface OpenGraphInput {
  readonly title?: string
  readonly description?: string
  /** Absolute URL of the share image (`og:image`). */
  readonly image?: string
  /** Canonical URL of the page (`og:url`). */
  readonly url?: string
  /** Object type (`og:type`) - `"website"`, `"article"`, … Default `"website"`. */
  readonly type?: string
}

/**
 * Build the Open Graph `<meta property="og:*">` entries for a route's `meta.meta`. Returns only the
 * properties you supplied (plus `og:type`, defaulting to `"website"`), so it composes with other meta.
 *
 * ```ts
 * export const meta = { meta: [...openGraph({ title: "Nifra", image: "https://site.com/og.png" })] }
 * ```
 */
export function openGraph(input: OpenGraphInput): MetaDescriptor[] {
  const tags: MetaDescriptor[] = []
  const add = (property: string, content: string | undefined): void => {
    if (content !== undefined) tags.push({ property, content })
  }
  add("og:title", input.title)
  add("og:description", input.description)
  add("og:image", input.image)
  add("og:url", input.url)
  // `og:type` always present (the spec's required property) - default "website" when unset.
  tags.push({ property: "og:type", content: input.type ?? "website" })
  return tags
}

/**
 * Build a JSON-LD `<script type="application/ld+json">` entry for a route's `meta.script` from a plain
 * object. `JSON.stringify` produces the body; the head renderer breakout-escapes it (see
 * `escapeScriptContent`), so a string field containing `</script>` is embedded safely.
 *
 * ```ts
 * export const meta = {
 *   script: [jsonLd({ "@context": "https://schema.org", "@type": "Article", headline: "Hi" })],
 * }
 * ```
 */
export function jsonLd(data: Record<string, unknown>): ScriptDescriptor {
  return { type: "application/ld+json", content: JSON.stringify(data) }
}
