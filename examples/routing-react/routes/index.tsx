import type { ActionData, LoaderData } from "@nifrajs/client"
import { Await } from "@nifrajs/web-react/await"
import type { action, loader } from "./index.backend.ts"

// Row numbers for the scroll-demo filler list (stable, unique → keyed by value, not array index).
const scrollRows = Array.from({ length: 100 }, (_, i) => i + 1)

// Static head for this route - SSR-injected + updated on client navigation.
export const meta = {
  title: "nifra - Home",
  meta: [{ name: "description", content: "nifra F7 counter demo" }],
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
      {/* Filler so the page scrolls - demonstrates F7 scroll restoration: scroll down, click
          "user 7", then Back, and this position is restored (a fresh nav starts at the top). */}
      <ul id="scroll-demo">
        {scrollRows.map((n) => (
          <li key={n}>scroll demo row {n}</li>
        ))}
      </ul>
    </div>
  )
}
