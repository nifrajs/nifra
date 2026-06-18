import type { LoaderArgs, LoaderData } from "@nifrajs/client"
import type { MetaArgs } from "@nifrajs/web"
import { Content } from "@nifrajs/web-solid/content"
import type { backend } from "../../backend"

// Load one post by slug. Dynamic import keeps the fs collection server-only.
export async function loader({ params }: LoaderArgs<typeof backend>) {
  const { posts } = await import("../../lib/content")
  const post = await posts.get(params.slug ?? "")
  return post
    ? { title: post.frontmatter.title, html: post.html }
    : { title: "Not found", html: "<p>No such post.</p>" }
}

export function meta({ data }: MetaArgs<LoaderData<typeof loader>>) {
  return { title: data.title }
}

export default function Post(props: { data: LoaderData<typeof loader> }) {
  return (
    <article id="post">
      <p>
        <a href="/">← back to posts</a>
      </p>
      {/* Renders the Markdown-rendered HTML via Solid's innerHTML (the <Content> helper). */}
      <Content html={props.data.html} />
    </article>
  )
}
