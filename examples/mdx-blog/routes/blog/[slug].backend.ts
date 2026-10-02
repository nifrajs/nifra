import { t } from "@nifrajs/schema"
import type { Route } from "./+types/[slug]"

export const loaderOutput = t.object({ title: t.string(), html: t.string() })

// Load one post by slug. Dynamic import keeps the fs collection server-only.
export async function loader({ params }: Route.LoaderArgs) {
  const { posts } = await import("../../backend/lib/content")
  const post = await posts.get(params.slug)
  return post
    ? { title: post.frontmatter.title, html: post.html }
    : { title: "Not found", html: "<p>No such post.</p>" }
}
