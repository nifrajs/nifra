import type { LoaderData } from "@nifrajs/client"
import { For } from "solid-js"

export const meta = { title: "nifra MDX blog (Solid)" }

// The collection is imported dynamically + used only here, so the `node:fs` reader never reaches the
// client bundle (the loader is stripped from the client build).
export async function loader() {
  const { posts } = await import("../lib/content")
  const all = await posts.all()
  return { posts: all.map((p) => ({ slug: p.slug, ...p.frontmatter })) }
}

export default function Index(props: { data: LoaderData<typeof loader> }) {
  return (
    <main>
      <h1 id="title">nifra blog</h1>
      <ul id="posts">
        <For each={props.data.posts}>
          {(p) => (
            <li>
              <a href={`/blog/${p.slug}`}>{p.title}</a> — <span>{p.summary}</span>
            </li>
          )}
        </For>
      </ul>
    </main>
  )
}
