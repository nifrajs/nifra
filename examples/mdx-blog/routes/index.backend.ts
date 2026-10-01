// The collection is imported dynamically + used only here, so the `node:fs` reader never reaches the
// client bundle (the loader is stripped from the client build).
export async function loader() {
  const { posts } = await import("../backend/lib/content")
  const all = await posts.all()
  return { posts: all.map((p) => ({ slug: p.slug, ...p.frontmatter })) }
}
