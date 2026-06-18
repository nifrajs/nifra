import type { ActionArgs, ActionData, LoaderArgs, LoaderData } from "@nifrajs/client"
import { defer } from "@nifrajs/web"
import { Await } from "@nifrajs/web-react/await"
import type { backend } from "../backend"

// Row numbers for the scroll-demo filler list (stable, unique → keyed by value, not array index).
const scrollRows = Array.from({ length: 100 }, (_, i) => i + 1)

// Static head for this route — SSR-injected + updated on client navigation.
export const meta = {
  title: "nifra — Home",
  meta: [{ name: "description", content: "nifra F7 counter demo" }],
}

// SSG: prerender this static route to dist/index.html at build (build.ts → prerenderRoutes). The
// loader runs at build (bakes the initial count); the page is then live after hydration — the form
// POST + revalidation hit the worker (hybrid). `defer()` here lives only in the action (not the
// prerendered GET), so the static document has no unresolved deferreds.
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
  // defer() in an ACTION: the mutation (the count++) returns immediately; the slow "receipt" streams
  // into <Await> afterward (on a client submit) without blocking the count update.
  return {
    ok: true,
    receipt: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("receipt #1042"), 300)),
    ),
  }
}

export default function Home(props: {
  data: LoaderData<typeof loader>
  actionData?: ActionData<typeof action>
}) {
  return (
    <div>
      <h1 id="page">Home</h1>
      <p id="count">count: {props.data.count}</p>
      <form method="post">
        <button id="inc" type="submit">
          increment
        </button>
      </form>
      {/* After a submit, the action's deferred receipt streams in here (data-mode) without blocking. */}
      {props.actionData ? (
        <Await resolve={props.actionData.receipt} fallback={<p id="receipt-fallback">receipt…</p>}>
          {(receipt) => <p id="receipt">{receipt}</p>}
        </Await>
      ) : null}
      {/* Filler so the page scrolls — demonstrates F7 scroll restoration: scroll down, click
          "user 7", then Back, and this position is restored (a fresh nav starts at the top). */}
      <ul id="scroll-demo">
        {scrollRows.map((n) => (
          <li key={n}>scroll demo row {n}</li>
        ))}
      </ul>
    </div>
  )
}
