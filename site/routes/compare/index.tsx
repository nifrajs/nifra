import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra compared - vs Next.js, Elysia, Hono, Fastify",
  "Honest, benchmark-backed comparisons of nifra against Next.js, Elysia, Hono, and Fastify - including where each alternative is the right choice.",
  "/compare",
)

const PAGES: ReadonlyArray<{ slug: string; title: string; summary: string }> = [
  {
    slug: "nextjs",
    title: "Nifra vs Next.js",
    summary:
      "28x SSR throughput in reproducible benchmarks, five UI frameworks instead of one, typed end-to-end without codegen - and why RSC-first apps should still pick Next.",
  },
  {
    slug: "elysia",
    title: "Nifra vs Elysia",
    summary:
      "Bun frameworks compared on identical workloads: level to ahead on Bun, ahead on Deno, and the backend-only vs full-stack difference.",
  },
  {
    slug: "hono",
    title: "Nifra vs Hono",
    summary:
      "What router micro-benchmarks hide, realistic middleware-stack throughput, and when Hono's run-anywhere minimalism is exactly right.",
  },
  {
    slug: "fastify",
    title: "Nifra vs Fastify",
    summary:
      "Ahead on Node in the current run - ~12% on the validated POST - and the same app unchanged on Bun runs several times faster. What each framework gives you beyond raw speed.",
  },
]

export default function CompareIndex() {
  return (
    <div className="prose">
      <h1 className="page">Nifra, compared</h1>
      <p className="lead">
        Honest comparisons, backed by <a href="/benchmarks">reproducible benchmarks</a> that publish
        the rows we lose. Each page says plainly where the alternative is the right choice.
      </p>
      {PAGES.map((page) => (
        <section key={page.slug}>
          <h2>
            <a href={`/compare/${page.slug}`}>{page.title}</a>
          </h2>
          <p>{page.summary}</p>
        </section>
      ))}
      <p>
        Want the single-page, capability-by-capability version instead? See{" "}
        <a href="/docs/comparison">the comparison doc</a>.
      </p>
    </div>
  )
}
