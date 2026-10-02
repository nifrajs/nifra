import type { LoaderArgs } from "@nifrajs/client"
import { t } from "@nifrajs/schema"
import type { backend } from "../../backend/app"

export const loaderOutput = t.object({ title: t.string(), html: t.string() })

// Load one post by slug. Dynamic import keeps the fs collection server-only.
export async function loader({ params }: LoaderArgs<typeof backend>) {
  const { posts } = await import("../../backend/lib/content")
  const post = await posts.get(params.slug ?? "")
  return post
    ? { title: post.frontmatter.title, html: post.html }
    : { title: "Not found", html: "<p>No such post.</p>" }
}
