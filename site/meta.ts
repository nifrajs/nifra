import type { Meta } from "@nifrajs/web"

// Shared per-route <head>: title + description + Open Graph + theme-color + favicon.
// createWebApp has no site-wide head, and React-19 metadata hoisting wouldn't reach Nifra's own
// <head> (Nifra renders the app as a body subtree) — so each route spreads this through Nifra's
// meta/link head API, the idiomatic path.

// Brand assets in public/ → /assets/* at deploy: the no-text ice-wolf mark is favicon (tab),
// apple-touch-icon (iOS), and logo-mark (header); og.jpg is the wordmark logo for social cards.
export function pageMeta(title: string, description: string): Meta {
  return {
    title,
    meta: [
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Nifra" },
      // The wordmark logo (served at /assets/og.jpg on every target). A purpose-built 1200×630 crop
      // is ideal for pixel-perfect cards; this square brand image renders everywhere.
      { property: "og:image", content: "/assets/og.jpg" },
      { name: "twitter:image", content: "/assets/og.jpg" },
      { name: "theme-color", content: "#0a1420" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    link: [
      { rel: "icon", type: "image/png", sizes: "64x64", href: "/assets/favicon.png" },
      { rel: "apple-touch-icon", href: "/assets/apple-touch-icon.png" },
    ],
  }
}
