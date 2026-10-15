import type { LoaderData } from "@nifrajs/client"
import { For } from "solid-js"
import type { loader } from "./index.backend.ts"

export const meta = { title: "nifra SSR bench (Solid)" }

export default function Index(props: { data: LoaderData<typeof loader> }) {
  return (
    <main>
      <h1>Items ({props.data.items.length})</h1>
      <ul>
        <For each={props.data.items}>{(it) => <li>{it.name}</li>}</For>
      </ul>
    </main>
  )
}
