import type { LoaderData } from "@nifrajs/client"
import { For } from "solid-js"
import type { loader } from "./index.backend.ts"

export const meta = { title: "nifra MDX blog (Solid)" }

export default function Index(props: { data: LoaderData<typeof loader> }) {
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
