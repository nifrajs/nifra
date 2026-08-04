import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra - Blog",
  "Engineering notes from building nifra: agent-native framework design, SSR performance, and honest benchmarking.",
  "/blog",
)

// One entry per post, newest first. Kept as data so the list stays trivial to extend.
const POSTS: ReadonlyArray<{ slug: string; date: string; title: string; summary: string }> = [
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

export default function BlogIndex() {
  return (
    <div className="prose">
      <h1 className="page">Blog</h1>
      <p className="lead">Engineering notes from building nifra.</p>
      {POSTS.map((post) => (
        <section key={post.slug}>
          <h2>
            <a href={`/blog/${post.slug}`}>{post.title}</a>
          </h2>
          <p>
            <em>{post.date}</em>
          </p>
          <p>{post.summary}</p>
        </section>
      ))}
    </div>
  )
}
