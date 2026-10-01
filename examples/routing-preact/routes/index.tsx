/** @jsxImportSource preact */

import type { ActionData, LoaderData } from "@nifrajs/client"
import { Await } from "@nifrajs/web-preact/await"
import type { action, loader } from "./index.backend.ts"

// Static head for this route - SSR-injected + updated on client navigation.
export const meta = {
  title: "nifra + Preact - Home",
  meta: [{ name: "description", content: "nifra Preact bindings: loader + action + defer/Await" }],
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
    </div>
  )
}
