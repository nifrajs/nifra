import { POSTS } from "../../data/posts"
import { breadcrumbs, FEED_LINK, pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra - Blog",
  "Engineering notes from building nifra: agent-native framework design, SSR performance, and honest benchmarking.",
  "/blog",
  {
    link: [FEED_LINK],
    structuredData: [
      // A `Blog` with its posts inline: the index is how a crawler discovers all nine URLs and their
      // dates in one fetch, independent of whether it follows the links.
      {
        "@context": "https://schema.org",
        "@type": "Blog",
        name: "Nifra Blog",
        description: "Engineering notes from building nifra.",
        url: "https://nifra.dev/blog",
        blogPost: POSTS.map((post) => ({
          "@type": "BlogPosting",
          headline: post.title,
          description: post.summary,
          datePublished: post.date,
          url: `https://nifra.dev/blog/${post.slug}`,
        })),
      },
      breadcrumbs([{ name: "Blog", path: "/blog" }]),
    ],
  },
)

export default function BlogIndex() {
  return (
    <div className="prose">
      <h1 className="page">Blog</h1>
      <p className="lead">
        Engineering notes from building nifra. <a href="/rss.xml">RSS</a>
      </p>
      {POSTS.map((post) => (
        <section key={post.slug}>
          <h2>
            <a href={`/blog/${post.slug}`}>{post.title}</a>
          </h2>
          <p>
            {/* `<time dateTime>` rather than a bare string: the visible date and the machine-readable
                one stay the same value, so the index agrees with each post's JSON-LD. */}
            <em>
              <time dateTime={post.date}>{post.date}</time>
            </em>
          </p>
          <p>{post.summary}</p>
        </section>
      ))}
    </div>
  )
}
