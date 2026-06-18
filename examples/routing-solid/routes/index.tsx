import type { ActionArgs, LoaderArgs, LoaderData } from "@nifrajs/client"
import { For } from "solid-js"
import type { backend } from "../backend"

// Row numbers for the scroll-demo filler list (stable, unique → keyed by value via <For>).
const scrollRows = Array.from({ length: 100 }, (_, i) => i + 1)

// Static head for this route — SSR-injected + updated on client navigation.
export const meta = {
  title: "nifra — Home",
  meta: [{ name: "description", content: "nifra F7 counter demo" }],
}

// SSG: prerender this static route to dist/index.html at build (build.ts → prerenderRoutes). Proves
// the prerender pipeline is framework-agnostic — same opt-in flag, Solid SSR output (with the SSR
// transform active at build). `defer()` lives only in the action, so the prerendered GET is clean.
export const prerender = true

// The full write-side loop, typed against the contract: the loader reads the count via the
// in-process api; the action increments it. After a client submit the loader REVALIDATES, so the
// count updates with no full reload. With JS off, the native POST re-renders the page with the
// fresh count (progressive enhancement). Loader + action are pure annotated functions (no value
// imports) so they tree-shake out of the client bundle.
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}

export async function action({ api }: ActionArgs<typeof backend>) {
  await api.count.post()
  return { ok: true }
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
      {/* Filler so the page scrolls — demonstrates F7 scroll restoration: scroll down, click
          "user 7", then Back, and this position is restored (a fresh nav starts at the top). */}
      <ul id="scroll-demo">
        <For each={scrollRows}>{(n) => <li>scroll demo row {n}</li>}</For>
      </ul>
    </div>
  )
}
