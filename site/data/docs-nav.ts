/**
 * The docs sidebar - the single source of truth for what `/docs/*` pages exist and what each one is
 * called.
 *
 * Two consumers: `routes/docs/_layout.tsx` renders it (and serializes it into the nav highlighter),
 * and `docsMeta()` looks a page's label up here so the `BreadcrumbList` a crawler reads says exactly
 * what the sidebar says. Adding a page to the sidebar is therefore also what gives it a breadcrumb.
 *
 * Ordered for a first-time reader: get a backend running, add a frontend, harden it, ship it,
 * migrate into it.
 */
export interface DocsLink {
  readonly href: string
  readonly label: string
}

export interface DocsGroup {
  readonly title: string
  readonly links: readonly DocsLink[]
}

export const DOCS_GROUPS: readonly DocsGroup[] = [
  {
    title: "Start here",
    links: [
      { href: "/docs", label: "Getting started" },
      { href: "/docs/contract", label: "Framework contract" },
      { href: "/docs/api", label: "API & typed client" },
      { href: "/docs/types-first", label: "Types-first" },
      { href: "/docs/testing", label: "Contract testing" },
      { href: "/docs/database", label: "Database" },
      { href: "/docs/comparison", label: "vs other frameworks" },
    ],
  },
  {
    title: "Frontend",
    links: [
      { href: "/docs/frameworks", label: "Frameworks" },
      { href: "/docs/routing", label: "Routing" },
      { href: "/docs/data", label: "Loaders & actions" },
      { href: "/docs/backends", label: "Backends & API" },
      { href: "/docs/server-functions", label: "Server functions" },
      { href: "/docs/mutations", label: "Optimistic UI" },
      { href: "/docs/query", label: "Query cache" },
      { href: "/docs/streaming", label: "Streaming" },
      { href: "/docs/hydration", label: "Hydration" },
      { href: "/docs/islands", label: "Islands" },
      { href: "/docs/content", label: "Content & MDX" },
      { href: "/docs/images", label: "Images" },
      { href: "/docs/fonts", label: "Fonts" },
      { href: "/docs/i18n", label: "i18n" },
    ],
  },
  {
    title: "Production",
    links: [
      { href: "/docs/auth", label: "Auth & sessions" },
      { href: "/docs/security", label: "Security & uploads" },
      { href: "/docs/security-comparison", label: "Security vs others" },
      { href: "/docs/budgets", label: "Request budgets" },
      { href: "/docs/plugins", label: "Plugins & middleware" },
      { href: "/docs/integrations", label: "Integrations" },
      { href: "/docs/edge", label: "Edge & bindings" },
      { href: "/docs/websockets", label: "WebSockets" },
    ],
  },
  {
    title: "Proof",
    links: [
      { href: "/docs/verification", label: "Verification ladder" },
      { href: "/docs/capabilities", label: "Effect provenance" },
      { href: "/docs/agents", label: "Coding agents" },
      { href: "/docs/causality", label: "Execution causality" },
      { href: "/docs/failure-lab", label: "Failure laboratory" },
      { href: "/docs/certification", label: "Adapter certification" },
    ],
  },
  {
    title: "Build & deploy",
    links: [
      { href: "/docs/rendering", label: "SSG & ISR" },
      { href: "/docs/dev", label: "Dev & HMR" },
      { href: "/docs/cli", label: "CLI" },
      { href: "/docs/deployment", label: "Deployment" },
      { href: "/docs/troubleshooting", label: "Troubleshooting" },
    ],
  },
  {
    title: "Migrate",
    links: [
      { href: "/docs/migrate-3", label: "Upgrade from Nifra 2.x" },
      { href: "/docs/migrate-2", label: "Upgrade from Nifra 1.x" },
      { href: "/docs/migrate-frontend", label: "From Next, Nuxt, SvelteKit" },
      { href: "/docs/migrate-backend", label: "From Express, Hono, Fastify" },
      { href: "/docs/migrate-route-by-route", label: "Migrate route by route" },
    ],
  },
]

/** The sidebar label for a docs path, or `undefined` for a page that is not in the sidebar (those
 * still get a head, just a `Docs`-only breadcrumb - an unlisted page is a real, allowed state). */
export function docsLabel(href: string): string | undefined {
  for (const group of DOCS_GROUPS) {
    const link = group.links.find((entry) => entry.href === href)
    if (link !== undefined) return link.label
  }
  return undefined
}
