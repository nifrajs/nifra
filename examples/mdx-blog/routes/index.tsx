import { For } from "solid-js"
import type { Route } from "./+types/index"

export const meta = { title: "nifra MDX blog (Solid)" }

export default function Index(props: Route.ComponentProps) {
  return (
    <main>
      <h1 id="title">nifra blog</h1>
      <ul id="posts">
        <For each={props.data.posts}>
          {(p) => (
            <li>
              <a href={`/blog/${p.slug}`}>{p.title}</a> - <span>{p.summary}</span>
            </li>
          )}
        </For>
      </ul>
    </main>
  )
}
