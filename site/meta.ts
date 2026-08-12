import type { LinkDescriptor, Meta, MetaDescriptor } from "@nifrajs/web"
import { canonical, jsonLd, openGraph } from "@nifrajs/web"
import { docsLabel } from "./data/docs-nav"
import { postBySlug } from "./data/posts"

// Shared per-route <head>: title + description + Open Graph + Twitter card + canonical + JSON-LD.
// createWebApp has no site-wide head, and React-19 metadata hoisting wouldn't reach Nifra's own
// <head> (Nifra renders the app as a body subtree) - so each route spreads this through Nifra's
// meta/link/script head API, the idiomatic path. The og:*/canonical/JSON-LD records are built with
// Nifra's own `openGraph()` / `canonical()` / `jsonLd()` helpers rather than hand-written: the site
// dogfoods the API it documents, and `jsonLd` bodies are breakout-escaped by the head renderer.

const SITE = "https://nifra.dev"
const OG_IMAGE = `${SITE}/assets/og.jpg`

/** Absolute URL for a site-root-relative path. Open Graph and JSON-LD both require absolute URLs -
 * a relative `og:image` is silently dropped by most scrapers. */
function absolute(path: string): string {
  return path.startsWith("http") ? path : `${SITE}${path}`
}

/** The Twitter-card records. `twitter:title`/`twitter:description` are NOT redundant with `og:*`:
 * X falls back to og when they are absent, but LinkedIn, Slack, and Discord each read a different
 * subset, so spelling both out is what makes a card render the same everywhere. */
function twitterCard(title: string, description: string): MetaDescriptor[] {
  return [
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: OG_IMAGE },
  ]
}

/** Extra head pieces a section helper layers onto {@link pageMeta}. */
export interface PageMetaExtras {
  /** `og:type` - `"article"` for a post, the default `"website"` otherwise. */
  readonly ogType?: string
  /** Additional `<meta>` records (e.g. `article:published_time`). */
  readonly meta?: readonly MetaDescriptor[]
  /** Additional `<link>` records (e.g. the blog's `rel="alternate"` feed). */
  readonly link?: readonly LinkDescriptor[]
  /** JSON-LD objects. Each becomes one `<script type="application/ld+json">`. */
  readonly structuredData?: readonly Record<string, unknown>[]
}

// Brand assets in public/ → /assets/* at deploy: the no-text ice-wolf mark is favicon (tab),
// apple-touch-icon (iOS), and logo-mark (header); og.jpg is the wordmark logo for social cards.
export function pageMeta(
  title: string,
  description: string,
  canonicalPath?: string,
  extras: PageMetaExtras = {},
): Meta {
  const url = canonicalPath !== undefined ? absolute(canonicalPath) : undefined
  return {
    title,
    meta: [
      { name: "description", content: description },
      // The wordmark logo (served at /assets/og.jpg on every target). A purpose-built 1200×630 crop
      // is ideal for pixel-perfect cards; this square brand image renders everywhere.
      ...openGraph({
        title,
        description,
        image: OG_IMAGE,
        ...(url !== undefined ? { url } : {}),
        ...(extras.ogType !== undefined ? { type: extras.ogType } : {}),
      }),
      { property: "og:site_name", content: "Nifra" },
      ...twitterCard(title, description),
      { name: "theme-color", content: "#0a1420" },
      ...(extras.meta ?? []),
    ],
    link: [
      // The canonical collapses host duplicates (www, *.pages.dev previews) onto the apex for
      // crawlers - every route passes its own path.
      ...(url !== undefined ? [canonical(url)] : []),
      { rel: "icon", type: "image/png", sizes: "64x64", href: "/assets/favicon.png" },
      { rel: "apple-touch-icon", href: "/assets/apple-touch-icon.png" },
      ...(extras.link ?? []),
    ],
    ...(extras.structuredData !== undefined && extras.structuredData.length > 0
      ? { script: extras.structuredData.map((data) => jsonLd(data)) }
      : {}),
  }
}

/** The blog feed, advertised from every blog URL. `rel="alternate"` is how a reader's "subscribe"
 * button finds `/rss.xml` from the page the reader is actually on. */
export const FEED_LINK: LinkDescriptor = {
  rel: "alternate",
  type: "application/rss+xml",
  title: "Nifra Blog",
  href: `${SITE}/rss.xml`,
}

/** One trail segment: the label a crawler shows and the path it points at. */
export interface Crumb {
  readonly name: string
  readonly path: string
}

/**
 * A `BreadcrumbList` for a page's trail, starting at the site root.
 *
 * Why it earns its bytes: without it Google prints the raw URL under a result; with it the result
 * shows `nifra.dev > Blog > Bun vs Node.js`. Emit AT MOST ONE per page - two `BreadcrumbList` blocks
 * on one document is ambiguous and gets dropped, which is why the section layouts stay out of this
 * and every trail is built at the page.
 */
export function breadcrumbs(trail: readonly Crumb[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [{ name: "Home", path: "/" }, ...trail].map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: absolute(crumb.path),
    })),
  }
}

/**
 * Head for a `/blog/<slug>` post: the page's own SEO title and description, plus the publication date
 * and a `BlogPosting` record derived from `data/posts.ts`.
 *
 * The date is the point. A post titled "... in 2026" with no machine-readable date is a freshness
 * claim a crawler cannot verify, so it does not get the benefit; `article:published_time` plus
 * `datePublished` makes the claim checkable.
 *
 * Throws on an unknown slug: silently emitting an undated head would ship exactly the defect this
 * helper exists to remove, and every caller is a literal in this repo, so the throw is a build-time
 * typo check rather than a runtime risk.
 */
export function postMeta(slug: string, title: string, description: string): Meta {
  const post = postBySlug(slug)
  if (post === undefined) {
    throw new Error(`[site] unknown post slug "${slug}" - add it to site/data/posts.ts`)
  }
  const path = `/blog/${slug}`
  return pageMeta(title, description, path, {
    ogType: "article",
    meta: [{ property: "article:published_time", content: post.date }],
    link: [FEED_LINK],
    structuredData: [
      {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: post.title,
        description: post.summary,
        image: OG_IMAGE,
        datePublished: post.date,
        dateModified: post.date,
        author: { "@type": "Organization", name: "Nifra", url: SITE },
        publisher: { "@type": "Organization", name: "Nifra", url: SITE },
        mainEntityOfPage: absolute(path),
      },
      breadcrumbs([
        { name: "Blog", path: "/blog" },
        { name: post.title, path },
      ]),
    ],
  })
}

/**
 * Head for a `/compare/<slug>` page. `TechArticle` rather than `BlogPosting`: these are maintained
 * reference pages, not dated posts, and a fabricated `datePublished` is worse than none.
 */
export function compareMeta(slug: string, name: string, title: string, description: string): Meta {
  const path = `/compare/${slug}`
  return pageMeta(title, description, path, {
    structuredData: [
      {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: title,
        description,
        image: OG_IMAGE,
        author: { "@type": "Organization", name: "Nifra", url: SITE },
        publisher: { "@type": "Organization", name: "Nifra", url: SITE },
        mainEntityOfPage: absolute(path),
      },
      breadcrumbs([
        { name: "Compare", path: "/compare" },
        { name, path },
      ]),
    ],
  })
}

/**
 * Head for a `/docs/...` page: `TechArticle` plus the docs trail.
 *
 * The crumb label comes from the sidebar (`data/docs-nav.ts`), not from an argument - the visible
 * nav and the structured trail cannot drift apart, and a page missing from the sidebar simply gets
 * the `Docs` crumb rather than a wrong one.
 */
export function docsMeta(path: string, title: string, description: string): Meta {
  const label = docsLabel(path)
  return pageMeta(title, description, path, {
    structuredData: [
      {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: title,
        description,
        image: OG_IMAGE,
        publisher: { "@type": "Organization", name: "Nifra", url: SITE },
        mainEntityOfPage: absolute(path),
      },
      breadcrumbs(
        path === "/docs" || label === undefined
          ? [{ name: "Documentation", path: "/docs" }]
          : [
              { name: "Documentation", path: "/docs" },
              { name: label, path },
            ],
      ),
    ],
  })
}

/**
 * The site-level `SoftwareApplication` record for the home page: what Nifra is, that it is free and
 * open source, and where the repository lives. This is the one block that describes the *project*
 * rather than a document, so it belongs on exactly one URL.
 */
export function softwareApplication(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Nifra",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Cross-platform",
    url: SITE,
    description:
      "The AI-native TypeScript framework: typed APIs and full-stack SSR on five UI libraries, one app across Bun, Node, Deno, and the edge.",
    license: "https://opensource.org/licenses/MIT",
    codeRepository: "https://github.com/nifrajs/nifra",
    programmingLanguage: "TypeScript",
    author: { "@type": "Organization", name: "Nifra", url: SITE },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  }
}
