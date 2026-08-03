import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra - Blog",
  "Engineering notes from building nifra: agent-native framework design, SSR performance, and honest benchmarking.",
)

// One entry per post, newest first. Kept as data so the list stays trivial to extend.
const POSTS: ReadonlyArray<{ slug: string; date: string; title: string; summary: string }> = [
  {
    slug: "docs-as-mcp",
    date: "2026-08-04",
    title: "Your framework's docs should be an MCP server",
    summary:
      "Most code is now written by an AI agent reading your docs. Why nifra ships its documentation, examples, and exact API types as a live MCP endpoint, and how CI keeps a machine-readable corpus from lying.",
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
