import type { LoaderData } from "@nifrajs/client"
import { For } from "solid-js"
import type { loader } from "./index.backend.ts"

// Row numbers for the scroll-demo filler list (stable, unique → keyed by value via <For>).
const scrollRows = Array.from({ length: 100 }, (_, i) => i + 1)

// Static head for this route - SSR-injected + updated on client navigation.
export const meta = {
  title: "nifra - Home",
  meta: [{ name: "description", content: "nifra F7 counter demo" }],
}

export default function Home(props: { data: LoaderData<typeof loader> }) {
  return (
    <div>
      <h1 id="page">Home</h1>
      <p id="count">count: {props.data.count}</p>
      <form method="post">
        <button id="inc" type="submit">
          increment
        </button>
      </form>
      {/* Filler so the page scrolls - demonstrates F7 scroll restoration: scroll down, click
          "user 7", then Back, and this position is restored (a fresh nav starts at the top). */}
      <ul id="scroll-demo">
        <For each={scrollRows}>{(n) => <li>scroll demo row {n}</li>}</For>
      </ul>
    </div>
  )
}
