/**
 * The blog's post index - the single source of truth for slug, date, display title, and summary.
 *
 * Three consumers read it, so a new post is one entry here plus one route file:
 *   - `/blog` renders the list from it,
 *   - each post's `postMeta(slug, ...)` head pulls its `datePublished` (both the `article:published_time`
 *     tag and the `BlogPosting` JSON-LD) from it, and
 *   - `scripts/gen-sitemap.ts` emits each post's `<lastmod>` and the `/rss.xml` feed from it.
 *
 * Dates are ISO `YYYY-MM-DD`. Keep NEWEST FIRST: the list order is the rendered order and the feed order.
 */
export interface Post {
  readonly slug: string
  /** ISO publication date. Surfaces to crawlers, so it must be the real date, not the edit date. */
  readonly date: string
  /** Display title, used by the index and the RSS item. A post's `<title>` may differ (it carries the
   * SEO phrasing plus the brand suffix); that one lives with the route. */
  readonly title: string
  readonly summary: string
}

export const POSTS: readonly Post[] = [
  {
    slug: "typescript-api-framework",
    date: "2026-08-04",
    title: "Choosing a TypeScript API framework in 2026",
    summary:
      "The three levels of 'typed' - handlers, inferred clients, runtime validation - and how Nifra, tRPC, Elysia, Hono, Fastify, and NestJS score on each, with a ten-minute test that beats any comparison table.",
  },
  {
    slug: "best-bun-frameworks-2026",
    date: "2026-08-04",
    title: "The best Bun frameworks in 2026",
    summary:
      "Elysia, Hono, and Nifra compared on speed, typing, scope, and ecosystem - with published benchmarks and our bias disclosed.",
  },
  {
    slug: "best-nodejs-frameworks-2026",
    date: "2026-08-04",
    title: "The best Node.js frameworks in 2026",
    summary:
      "Fastify, Express, NestJS, Hono, and Nifra - measured throughput, typing stories, and a one-minute decision guide.",
  },
  {
    slug: "bun-vs-node",
    date: "2026-08-04",
    title: "Bun vs Node.js: same app, both runtimes, measured",
    summary:
      "The comparison most benchmarks fake: an identical application benchmarked on both runtimes. Where Bun's 2x holds and where it shrinks.",
  },
  {
    slug: "fastify-vs-express",
    date: "2026-08-04",
    title: "Fastify vs Express in 2026: measured, not vibes",
    summary: "Fresh numbers for the eternal Node question, plus when neither is the right answer.",
  },
  {
    slug: "elysia-vs-hono",
    date: "2026-08-04",
    title: "Elysia vs Hono in 2026: which Bun framework fits",
    summary:
      "Identical-workload throughput, Eden vs hc, validation, portability - and the one difference that decides most projects.",
  },
  {
    slug: "nextjs-alternatives-2026",
    date: "2026-08-04",
    title: "Next.js alternatives in 2026 - what to use and when",
    summary:
      "Remix, SvelteKit, Nuxt, SolidStart, Astro, and Nifra matched to the three reasons people actually leave - including when staying is right.",
  },
  {
    slug: "fullstack-bun-guide",
    date: "2026-08-04",
    title: "Building a full-stack TypeScript app on Bun",
    summary:
      "From scaffold to deploy: file-based routes, typed loaders, validation at the boundary, and why the same app runs unchanged on Node, Deno, or the edge.",
  },
  {
    slug: "docs-as-mcp",
    date: "2026-08-04",
    title: "Your framework's docs should be an MCP server",
    summary:
      "Most code is now written by an AI agent reading your docs. Why Nifra ships its documentation, examples, and exact API types as a live MCP endpoint, and how CI keeps a machine-readable corpus from lying.",
  },
]

/** A post by slug, or `undefined`. `postMeta` throws on a miss rather than silently emitting a head
 * with no date - a typo in a slug would otherwise ship a post that crawlers read as undated. */
export function postBySlug(slug: string): Post | undefined {
  return POSTS.find((post) => post.slug === slug)
}
