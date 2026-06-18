/** @jsxImportSource preact */
import type { ActionArgs, ActionData, LoaderArgs, LoaderData } from "@nifrajs/client"
import { defer } from "@nifrajs/web"
import { Await } from "@nifrajs/web-preact/await"
import type { backend } from "../backend"

// Static head for this route — SSR-injected + updated on client navigation.
export const meta = {
  title: "nifra + Preact — Home",
  meta: [{ name: "description", content: "nifra Preact bindings: loader + action + defer/Await" }],
}

// SSG: prerender this static route to dist/index.html at build (build.ts → prerenderRoutes). Proves
// the prerender pipeline is framework-agnostic — same opt-in flag, Preact render output. `defer()`
// lives only in the action, so the prerendered GET has no unresolved deferreds.
export const prerender = true

// Loader reads the count via the in-process api; the action increments it. After a client submit the
// loader REVALIDATES, so the count updates with no full reload (progressive enhancement with JS off).
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}

export async function action({ api }: ActionArgs<typeof backend>) {
  await api.count.post()
  // defer() in an ACTION: the mutation (count++) returns immediately; the slow "receipt" streams into
  // <Await> afterward (on a client submit) without blocking the count update.
  return {
    ok: true,
    receipt: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("receipt #1042"), 200)),
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
    </div>
  )
}
