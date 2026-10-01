import type { LoaderArgs } from "@nifrajs/client"
import type { backend } from "../../backend/app"

// Load one post by slug. Dynamic import keeps the fs collection server-only.
export async function loader({ params }: LoaderArgs<typeof backend>) {
  const { posts } = await import("../../backend/lib/content")
  const post = await posts.get(params.slug ?? "")
  return post
    ? { title: post.frontmatter.title, html: post.html }
    : { title: "Not found", html: "<p>No such post.</p>" }
}
